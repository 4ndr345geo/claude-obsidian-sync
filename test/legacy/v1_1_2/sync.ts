import { App, normalizePath, TFile, TFolder } from "obsidian";
import SparkMD5 from "spark-md5";
import { DriveClient } from "./drive";
import { conflictPath, isMergeable, mergeText } from "./merge";
import { Action, BaseEntry, LocalEntry, planSync, RemoteEntry } from "./plan";

export interface SyncState {
	base: Record<string, BaseEntry>;
	/** Hash cache so unchanged files don't need to be re-read on every sync. */
	cache: Record<string, { mtime: number; size: number; hash: string }>;
	folderId: string;
	folderName: string;
}

export interface SyncSettingsView {
	folderName: string;
	deviceName: string;
	excludes: string[];
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deleted: number;
	merged: number;
	/** Notes in which critical changes were marked. */
	marked: string[];
	/** Conflict copies created (binary files). */
	conflicts: string[];
	errors: string[];
}

export function md5(data: ArrayBuffer): string {
	return SparkMD5.ArrayBuffer.hash(data);
}

function globToRegExp(glob: string): RegExp {
	const re = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${re}$`);
}

export function makeExcluder(patterns: string[]): (path: string) => boolean {
	const rules = patterns
		.map((p) => p.trim())
		.filter((p) => p && !p.startsWith("#"))
		.map((p) => {
			const clean = p.replace(/^\/+|\/+$/g, "");
			const re = globToRegExp(clean);
			return (path: string) => re.test(path) || path.startsWith(clean + "/");
		});
	return (path) => rules.some((r) => r(path));
}

export class SyncEngine {
	constructor(
		private app: App,
		private drive: DriveClient,
		private state: SyncState,
		private settings: () => SyncSettingsView,
		private baseDir: string,
		private persist: () => Promise<void>
	) {}

	private get vault() {
		return this.app.vault;
	}

	async run(onProgress?: (msg: string) => void): Promise<SyncResult> {
		const s = this.settings();
		const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, merged: 0, marked: [], conflicts: [], errors: [] };

		if (!this.state.folderId || this.state.folderName !== s.folderName) {
			this.state.folderId = await this.drive.ensureFolder(s.folderName);
			if (this.state.folderName !== s.folderName) {
				// Different remote folder -> previous base state is meaningless.
				this.state.base = {};
			}
			this.state.folderName = s.folderName;
		}

		onProgress?.("Lese Google Drive …");
		const remoteList = await this.drive.listFiles(this.state.folderId);
		const excluded = makeExcluder(s.excludes);
		const remoteFiltered = remoteList.filter((r) => !excluded(r.path));
		const remoteById = new Map(remoteFiltered.map((r) => [r.id, r]));

		onProgress?.("Prüfe lokale Dateien …");
		const local = await this.scanLocal(excluded);

		const plan = planSync(local, remoteFiltered, this.state.base);
		const work = plan.actions.filter((a) => a.type !== "setBase" && a.type !== "dropBase");
		let done = 0;

		for (const dup of plan.duplicates) {
			try {
				await this.resolveDuplicate(dup, remoteFiltered, result);
			} catch (e) {
				result.errors.push(`${dup.path}: ${(e as Error).message}`);
			}
		}

		for (const action of plan.actions) {
			try {
				if (action.type !== "setBase" && action.type !== "dropBase") {
					done++;
					onProgress?.(`Synchronisiere ${done}/${work.length} …`);
				}
				await this.execute(action, local, remoteById, result);
			} catch (e) {
				result.errors.push(`${action.path}: ${(e as Error).message}`);
			}
			if (done % 25 === 0) await this.persist();
		}

		// Forget cache entries for files that no longer exist.
		for (const p of Object.keys(this.state.cache)) {
			if (!this.vault.getAbstractFileByPath(p)) delete this.state.cache[p];
		}
		await this.persist();
		return result;
	}

	private async scanLocal(excluded: (p: string) => boolean): Promise<Map<string, LocalEntry>> {
		const out = new Map<string, LocalEntry>();
		for (const file of this.vault.getFiles()) {
			if (excluded(file.path)) continue;
			const { mtime, size } = file.stat;
			let cached = this.state.cache[file.path];
			if (!cached || cached.mtime !== mtime || cached.size !== size) {
				const data = await this.vault.readBinary(file);
				cached = { mtime, size, hash: md5(data) };
				this.state.cache[file.path] = cached;
			}
			out.set(file.path, { path: file.path, hash: cached.hash, mtime });
		}
		return out;
	}

	/** True if the local file still matches what we saw during the scan. */
	private unchangedSinceScan(path: string, local: Map<string, LocalEntry>): boolean {
		const f = this.vault.getAbstractFileByPath(path);
		const seen = local.get(path);
		if (!f) return !seen;
		if (!(f instanceof TFile) || !seen) return false;
		return f.stat.mtime === seen.mtime;
	}

	private async execute(
		a: Action,
		local: Map<string, LocalEntry>,
		remoteById: Map<string, RemoteEntry>,
		r: SyncResult
	): Promise<void> {
		switch (a.type) {
			case "setBase":
				this.state.base[a.path] = { hash: a.hash, remoteId: a.remoteId };
				if (isMergeable(a.path)) {
					const f = this.vault.getAbstractFileByPath(a.path);
					if (f instanceof TFile) await this.writeBaseText(a.path, await this.vault.read(f));
				}
				return;
			case "dropBase":
				await this.forget(a.path);
				return;
			case "upload":
				await this.uploadPath(a.path, a.remoteId);
				r.uploaded++;
				return;
			case "download": {
				if (!this.unchangedSinceScan(a.path, local)) return; // edited right now -> next round
				const data = await this.drive.download(a.remoteId);
				await this.writeLocal(a.path, data);
				await this.setBaseFromData(a.path, data, a.remoteId);
				r.downloaded++;
				return;
			}
			case "deleteLocal": {
				if (!this.unchangedSinceScan(a.path, local)) return;
				const f = this.vault.getAbstractFileByPath(a.path);
				if (f) await this.app.fileManager.trashFile(f);
				await this.forget(a.path);
				await this.removeEmptyParents(a.path);
				r.deleted++;
				return;
			}
			case "deleteRemote":
				await this.drive.trash(a.remoteId);
				await this.forget(a.path);
				r.deleted++;
				return;
			case "conflict":
				if (!this.unchangedSinceScan(a.path, local)) return;
				await this.resolveConflict(a.path, a.remoteId, a.hasBase, remoteById.get(a.remoteId), r);
				return;
		}
	}

	private async resolveConflict(
		path: string,
		remoteId: string,
		hasBase: boolean,
		remote: RemoteEntry | undefined,
		r: SyncResult
	): Promise<void> {
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const localData = await this.vault.readBinary(file);
		const remoteData = await this.drive.download(remoteId);

		// 1) Text notes: three-way merge. Uncritical changes are combined,
		//    critical ones are marked directly in the note.
		if (isMergeable(path)) {
			const dec = new TextDecoder();
			const localText = dec.decode(localData);
			const remoteText = dec.decode(remoteData);
			const baseText = hasBase ? await this.readBaseText(path) : null;
			const m = mergeText(
				localText,
				baseText,
				remoteText,
				{ label: this.settings().deviceName, time: file.stat.mtime },
				{ label: remote?.device ?? "anderes Gerät", time: remote?.modifiedTime ?? 0 }
			);
			const merged = new TextEncoder().encode(m.text).buffer as ArrayBuffer;
			if (m.text !== localText) await this.writeLocal(path, merged);
			await this.uploadData(path, merged, remoteId);
			if (m.clean) r.merged++;
			else r.marked.push(path);
			return;
		}

		// 2) Binary files (images, PDFs …) cannot be merged:
		//    the newer version keeps the name, the older one becomes a copy.
		const remoteTime = remote?.modifiedTime ?? 0;
		const localWins = file.stat.mtime >= remoteTime;
		if (localWins) {
			const copy = this.freePath(conflictPath(path, remote?.device ?? "anderes Gerät"));
			await this.writeLocal(copy, remoteData);
			await this.uploadPath(copy);
			await this.uploadData(path, localData, remoteId);
			r.conflicts.push(copy);
		} else {
			const copy = this.freePath(conflictPath(path, this.settings().deviceName));
			await this.writeLocal(copy, localData);
			await this.uploadPath(copy);
			await this.writeLocal(path, remoteData);
			await this.setBaseFromData(path, remoteData, remoteId);
			r.conflicts.push(copy);
		}
	}

	/** Two remote files for the same path (created at the same time on two devices). */
	private async resolveDuplicate(dup: RemoteEntry, all: RemoteEntry[], r: SyncResult): Promise<void> {
		const primary = all.find((x) => x.path === dup.path && x.id !== dup.id && x.md5 !== undefined);
		if (primary && primary.md5 === dup.md5) {
			await this.drive.trash(dup.id);
			return;
		}
		const data = await this.drive.download(dup.id);
		const copy = this.freePath(conflictPath(dup.path, dup.device ?? "anderes Gerät"));
		await this.writeLocal(copy, data);
		await this.uploadPath(copy);
		await this.drive.trash(dup.id);
		r.conflicts.push(copy);
	}

	private async uploadPath(path: string, remoteId?: string): Promise<void> {
		const f = this.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return;
		await this.uploadData(path, await this.vault.readBinary(f), remoteId);
	}

	private async uploadData(path: string, data: ArrayBuffer, remoteId?: string): Promise<void> {
		const f = this.vault.getAbstractFileByPath(path);
		const entry = await this.drive.upload(
			this.state.folderId,
			path,
			data,
			this.settings().deviceName,
			remoteId,
			f instanceof TFile ? f.stat.mtime : Date.now()
		);
		await this.setBaseFromData(path, data, entry.id);
	}

	private async setBaseFromData(path: string, data: ArrayBuffer, remoteId: string) {
		const hash = md5(data);
		this.state.base[path] = { hash, remoteId };
		const f = this.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) {
			this.state.cache[path] = { mtime: f.stat.mtime, size: f.stat.size, hash };
		}
		if (isMergeable(path)) {
			await this.writeBaseText(path, new TextDecoder().decode(data));
		}
	}

	private async forget(path: string) {
		delete this.state.base[path];
		delete this.state.cache[path];
		const p = this.baseTextPath(path);
		if (await this.vault.adapter.exists(p)) await this.vault.adapter.remove(p);
	}

	private async writeLocal(path: string, data: ArrayBuffer): Promise<void> {
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, data);
			return;
		}
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (dir && !this.vault.getAbstractFileByPath(dir)) {
			await this.vault.createFolder(dir).catch(() => undefined);
		}
		await this.vault.createBinary(path, data);
	}

	private async removeEmptyParents(path: string) {
		let dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		while (dir) {
			const f = this.vault.getAbstractFileByPath(dir);
			if (!(f instanceof TFolder) || f.children.length > 0) return;
			await this.vault.delete(f).catch(() => undefined);
			dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
		}
	}

	private freePath(path: string): string {
		if (!this.vault.getAbstractFileByPath(path)) return path;
		const dot = path.lastIndexOf(".");
		const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
		const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
		for (let i = 2; ; i++) {
			const candidate = `${stem} ${i}${ext}`;
			if (!this.vault.getAbstractFileByPath(candidate)) return candidate;
		}
	}

	// --- Base copies (needed for three-way merges), stored per device in the plugin folder ---

	private baseTextPath(path: string) {
		return normalizePath(`${this.baseDir}/${SparkMD5.hash(path)}.txt`);
	}

	private async writeBaseText(path: string, text: string) {
		const adapter = this.vault.adapter;
		if (!(await adapter.exists(this.baseDir))) await adapter.mkdir(this.baseDir);
		await adapter.write(this.baseTextPath(path), text);
	}

	private async readBaseText(path: string): Promise<string | null> {
		const p = this.baseTextPath(path);
		return (await this.vault.adapter.exists(p)) ? await this.vault.adapter.read(p) : null;
	}
}
