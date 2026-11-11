import { App, normalizePath, TFile, TFolder } from "obsidian";
import SparkMD5 from "spark-md5";
import { DriveClient } from "./drive";
import { ConfigSyncOptions, makeConfigFilter } from "./config";
import { conflictPath, isMergeable, mergeJson, mergeText } from "./merge";
import { isSafeSyncPath } from "./paths";
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
	config: ConfigSyncOptions;
}

export type SyncEventKind =
	| "up"
	| "down"
	| "delLocal"
	| "delRemote"
	| "merged"
	| "marked"
	| "copy"
	| "error";

export interface SyncEvent {
	kind: SyncEventKind;
	path: string;
	detail?: string;
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
	/** Settings from another device were applied -> Obsidian should be reloaded. */
	configChanged: boolean;
	/** What happened, file by file (for the sync log). */
	events: SyncEvent[];
}

/** Thrown before anything is changed when a sync would delete unusually many files. */
export class MassDeleteError extends Error {
	constructor(public local: number, public remote: number, public total: number) {
		super(
			`Sicherheitsstopp: Diese Synchronisierung würde ${local + remote} von ${total} Dateien löschen ` +
				`(${local} auf diesem Gerät, ${remote} in Google Drive). Es wurde nichts geändert.`
		);
	}
}

/** A sync that deletes at least this many files … */
export const MASS_DELETE_MIN = 20;
/** … and at least this share of all files needs a confirmation. */
export const MASS_DELETE_SHARE = 0.5;

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

function snapshot(r: SyncResult) {
	return {
		up: r.uploaded,
		down: r.downloaded,
		del: r.deleted,
		merged: r.merged,
		marked: r.marked.length,
		copies: r.conflicts.length,
	};
}

/** Derives per-file events from the counters an action changed. */
function recordEvents(r: SyncResult, b: ReturnType<typeof snapshot>, path: string, localDelete: boolean) {
	if (r.deleted > b.del) r.events.push({ kind: localDelete ? "delLocal" : "delRemote", path });
	if (r.marked.length > b.marked) r.events.push({ kind: "marked", path });
	else if (r.merged > b.merged) r.events.push({ kind: "merged", path });
	for (const copy of r.conflicts.slice(b.copies)) r.events.push({ kind: "copy", path: copy, detail: path });
	if (r.conflicts.length === b.copies && r.marked.length === b.marked && r.merged === b.merged) {
		if (r.uploaded > b.up) r.events.push({ kind: "up", path });
		if (r.downloaded > b.down) r.events.push({ kind: "down", path });
	}
}

export class SyncEngine {
	constructor(
		private app: App,
		private drive: DriveClient,
		private state: SyncState,
		private settings: () => SyncSettingsView,
		private baseDir: string,
		private persist: () => Promise<void>,
		private ownPluginId = "gdrive-vault-sync"
	) {}

	private get configPrefix() {
		return this.vault.configDir + "/";
	}

	/** File inside the settings folder (.obsidian)? Those are handled via the adapter. */
	private isConfig(path: string) {
		return path.startsWith(this.configPrefix);
	}

	private get vault() {
		return this.app.vault;
	}

	/**
	 * @param allowMassDelete  the user confirmed that many deletions are intended
	 */
	async run(onProgress?: (msg: string) => void, allowMassDelete = false): Promise<SyncResult> {
		const s = this.settings();
		const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, merged: 0, marked: [], conflicts: [], errors: [], configChanged: false, events: [] };

		// The remembered folder was deleted or trashed in Google Drive: start
		// over with a new folder and upload, instead of deleting everything here.
		if (this.state.folderId && this.state.folderName === s.folderName) {
			if (!(await this.drive.folderUsable(this.state.folderId))) {
				this.state.folderId = "";
				this.state.base = {};
			}
		}
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
		const userExcluded = makeExcluder(s.excludes);
		const configWanted = makeConfigFilter(this.vault.configDir, this.ownPluginId, s.config);
		// The same rule for local and remote files. Unsafe paths (leaving the
		// vault, hidden folders, aliases of the settings folder) are ignored.
		const excluded = (p: string) =>
			!isSafeSyncPath(p, this.vault.configDir) ||
			userExcluded(p) ||
			(this.isConfig(p) && !configWanted(p));
		const unsafe = remoteList.filter((r) => !isSafeSyncPath(r.path, this.vault.configDir));
		if (unsafe.length) {
			console.warn(
				`[Google Drive Sync] ${unsafe.length} Datei(en) in Google Drive mit unsicherem Pfad ignoriert:`,
				unsafe.slice(0, 20).map((r) => r.path)
			);
		}
		const remoteFiltered = remoteList.filter((r) => !excluded(r.path));
		const remoteById = new Map(remoteFiltered.map((r) => [r.id, r]));

		onProgress?.("Prüfe lokale Dateien …");
		const local = await this.scanLocal(excluded);
		if (s.config.enabled) await this.scanConfig(this.vault.configDir, excluded, local);

		const plan = planSync(local, remoteFiltered, this.state.base);
		const work = plan.actions.filter((a) => a.type !== "setBase" && a.type !== "dropBase");
		let done = 0;

		// An emptied or replaced Drive folder (or an emptied vault) would look
		// like "everything was deleted on the other side". Stop before that.
		const delLocal = plan.actions.filter((a) => a.type === "deleteLocal").length;
		const delRemote = plan.actions.filter((a) => a.type === "deleteRemote").length;
		const total = Math.max(Object.keys(this.state.base).length, local.size, remoteFiltered.length);
		if (
			!allowMassDelete &&
			delLocal + delRemote >= MASS_DELETE_MIN &&
			delLocal + delRemote >= total * MASS_DELETE_SHARE
		) {
			throw new MassDeleteError(delLocal, delRemote, total);
		}

		for (const dup of plan.duplicates) {
			const before = snapshot(result);
			try {
				await this.resolveDuplicate(dup, remoteFiltered, result);
			} catch (e) {
				result.errors.push(`${dup.path}: ${(e as Error).message}`);
				result.events.push({ kind: "error", path: dup.path, detail: (e as Error).message });
			}
			recordEvents(result, before, dup.path, false);
		}

		for (const action of plan.actions) {
			try {
				if (action.type !== "setBase" && action.type !== "dropBase") {
					done++;
					onProgress?.(`Synchronisiere ${done}/${work.length} …`);
				}
				const before = snapshot(result);
				try {
					await this.execute(action, local, remoteById, result);
				} finally {
					recordEvents(result, before, action.path, action.type === "deleteLocal");
				}
			} catch (e) {
				result.errors.push(`${action.path}: ${(e as Error).message}`);
				result.events.push({ kind: "error", path: action.path, detail: (e as Error).message });
			}
			if (done % 25 === 0) await this.persist();
		}

		// Forget cache entries for files that are gone or no longer synchronised.
		for (const p of Object.keys(this.state.cache)) {
			if (!local.has(p) && !(await this.statLocal(p))) delete this.state.cache[p];
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

	/** Recursively scans the settings folder (not part of Obsidian's file index). */
	private async scanConfig(dir: string, excluded: (p: string) => boolean, out: Map<string, LocalEntry>) {
		// A folder that cannot be read must stop the sync – skipping it would
		// look as if its files had been deleted on this device.
		if (!(await this.vault.adapter.exists(dir))) return;
		const listing = await this.vault.adapter.list(dir);
		for (const path of listing.files) {
			if (excluded(path)) continue;
			const st = await this.vault.adapter.stat(path);
			if (!st || st.type !== "file") continue;
			let cached = this.state.cache[path];
			if (!cached || cached.mtime !== st.mtime || cached.size !== st.size) {
				const data = await this.vault.adapter.readBinary(path);
				cached = { mtime: st.mtime, size: st.size, hash: md5(data) };
				this.state.cache[path] = cached;
			}
			out.set(path, { path, hash: cached.hash, mtime: st.mtime });
		}
		for (const folder of listing.folders) {
			// Skip folders that can never contain synchronised files.
			if (folder === normalizePath(this.baseDir).replace(/\/base$/, "")) continue;
			await this.scanConfig(folder, excluded, out);
		}
	}

	private async statLocal(path: string): Promise<{ mtime: number; size: number } | null> {
		if (this.isConfig(path)) {
			const st = await this.vault.adapter.stat(path);
			return st && st.type === "file" ? { mtime: st.mtime, size: st.size } : null;
		}
		const f = this.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? { mtime: f.stat.mtime, size: f.stat.size } : null;
	}

	private async readLocal(path: string): Promise<ArrayBuffer | null> {
		if (this.isConfig(path)) {
			return (await this.vault.adapter.exists(path)) ? this.vault.adapter.readBinary(path) : null;
		}
		const f = this.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? this.vault.readBinary(f) : null;
	}

	/** True if the local file still matches what we saw during the scan. */
	private async unchangedSinceScan(path: string, local: Map<string, LocalEntry>): Promise<boolean> {
		const st = await this.statLocal(path);
		const seen = local.get(path);
		if (!st) return !seen;
		if (!seen) return false;
		return st.mtime === seen.mtime;
	}

	/** Base copies are kept for notes (line merge) and settings files (JSON merge). */
	private keepsBaseText(path: string) {
		return isMergeable(path) || (this.isConfig(path) && path.endsWith(".json"));
	}

	private async execute(
		a: Action,
		local: Map<string, LocalEntry>,
		remoteById: Map<string, RemoteEntry>,
		r: SyncResult
	): Promise<void> {
		switch (a.type) {
			case "setBase": {
				this.state.base[a.path] = { hash: a.hash, remoteId: a.remoteId };
				if (this.keepsBaseText(a.path)) {
					const data = await this.readLocal(a.path);
					if (data) await this.writeBaseText(a.path, new TextDecoder().decode(data));
				}
				return;
			}
			case "dropBase":
				await this.forget(a.path);
				return;
			case "upload":
				await this.uploadPath(a.path, a.remoteId);
				r.uploaded++;
				return;
			case "download": {
				if (!(await this.unchangedSinceScan(a.path, local))) return; // edited right now -> next round
				const data = await this.downloadVerified(a.remoteId, remoteById.get(a.remoteId));
				await this.writeLocal(a.path, data);
				await this.setBaseFromData(a.path, data, a.remoteId);
				r.downloaded++;
				if (this.isConfig(a.path)) r.configChanged = true;
				return;
			}
			case "deleteLocal": {
				if (!(await this.unchangedSinceScan(a.path, local))) return;
				if (this.isConfig(a.path)) {
					if (await this.vault.adapter.exists(a.path)) await this.vault.adapter.remove(a.path);
					await this.removeEmptyConfigParents(a.path);
					r.configChanged = true;
				} else {
					const f = this.vault.getAbstractFileByPath(a.path);
					if (f) await this.app.fileManager.trashFile(f);
					await this.removeEmptyParents(a.path);
				}
				await this.forget(a.path);
				r.deleted++;
				return;
			}
			case "deleteRemote":
				await this.drive.trash(a.remoteId);
				await this.forget(a.path);
				r.deleted++;
				return;
			case "conflict":
				if (!(await this.unchangedSinceScan(a.path, local))) return;
				if (this.isConfig(a.path)) {
					await this.resolveConfigConflict(a.path, a.remoteId, a.hasBase, remoteById.get(a.remoteId), r);
					return;
				}
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
		const remoteData = await this.downloadVerified(remoteId, remote);

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
			// Upload first. If it fails, nothing has changed on this device, and the
			// next sync starts from the same state (otherwise the conflict marking
			// would be merged again and again and the note would keep growing).
			const entry = await this.drive.upload(
				this.state.folderId,
				path,
				merged,
				this.settings().deviceName,
				remoteId,
				Date.now()
			);
			if (m.text !== localText) await this.writeLocal(path, merged);
			await this.setBaseFromData(path, merged, entry.id);
			if (m.clean) r.merged++;
			else r.marked.push(path);
			return;
		}

		// 2) Binary files (images, PDFs …) cannot be merged:
		//    the newer version keeps the name, the older one becomes a copy.
		const remoteTime = remote?.modifiedTime ?? 0;
		const localWins = file.stat.mtime >= remoteTime;
		// Order matters: the conflict has to be settled before anything that can
		// fail over the network, otherwise every retry would create another copy.
		// A copy that could not be uploaded is simply a new file for the next sync.
		if (localWins) {
			const copy = this.freePath(conflictPath(path, remote?.device ?? "anderes Gerät"));
			await this.uploadData(path, localData, remoteId);
			await this.writeLocal(copy, remoteData);
			r.conflicts.push(copy);
			await this.uploadPath(copy);
		} else {
			const copy = this.freePath(conflictPath(path, this.settings().deviceName));
			await this.writeLocal(copy, localData);
			await this.writeLocal(path, remoteData);
			await this.setBaseFromData(path, remoteData, remoteId);
			r.conflicts.push(copy);
			await this.uploadPath(copy);
		}
	}

	/**
	 * Settings files: JSON files are merged per setting (conflicting settings:
	 * newer wins); other files (CSS, plugin code) are replaced by the newer
	 * version. No conflict copies, no markers – that would break the settings.
	 */
	private async resolveConfigConflict(
		path: string,
		remoteId: string,
		hasBase: boolean,
		remote: RemoteEntry | undefined,
		r: SyncResult
	): Promise<void> {
		const st = await this.statLocal(path);
		const localData = await this.readLocal(path);
		if (!st || !localData) return;
		const remoteData = await this.downloadVerified(remoteId, remote);
		const localNewer = st.mtime >= (remote?.modifiedTime ?? 0);

		let result: ArrayBuffer = localNewer ? localData : remoteData;
		if (path.endsWith(".json")) {
			const dec = new TextDecoder();
			const merged = mergeJson(
				dec.decode(localData),
				hasBase ? await this.readBaseText(path) : null,
				dec.decode(remoteData),
				localNewer
			);
			if (merged !== null) result = new TextEncoder().encode(merged).buffer as ArrayBuffer;
		}
		if (md5(result) !== md5(localData)) {
			await this.writeLocal(path, result);
			r.configChanged = true;
		}
		await this.uploadData(path, result, remoteId);
		r.merged++;
	}

	/** Two remote files for the same path (created at the same time on two devices). */
	private async resolveDuplicate(dup: RemoteEntry, all: RemoteEntry[], r: SyncResult): Promise<void> {
		const primary = all.find((x) => x.path === dup.path && x.id !== dup.id && x.md5 !== undefined);
		if ((primary && primary.md5 === dup.md5) || this.isConfig(dup.path)) {
			await this.drive.trash(dup.id);
			return;
		}
		const data = await this.downloadVerified(dup.id, dup);
		const copy = this.freePath(conflictPath(dup.path, dup.device ?? "anderes Gerät"));
		await this.writeLocal(copy, data);
		// Remove the duplicate before uploading the copy: if the upload fails,
		// the copy is uploaded by the next sync instead of being created again.
		await this.drive.trash(dup.id);
		r.conflicts.push(copy);
		await this.uploadPath(copy);
	}

	/** Downloads a file and makes sure it arrived completely and unchanged. */
	private async downloadVerified(id: string, remote: RemoteEntry | undefined): Promise<ArrayBuffer> {
		const data = await this.drive.download(id);
		if (remote?.md5 && md5(data) !== remote.md5) {
			throw new Error("Download unvollständig oder Datei gerade geändert – wird beim nächsten Mal erneut versucht.");
		}
		return data;
	}

	private async uploadPath(path: string, remoteId?: string): Promise<void> {
		const data = await this.readLocal(path);
		if (!data) return;
		await this.uploadData(path, data, remoteId);
	}

	private async uploadData(path: string, data: ArrayBuffer, remoteId?: string): Promise<void> {
		const st = await this.statLocal(path);
		const entry = await this.drive.upload(
			this.state.folderId,
			path,
			data,
			this.settings().deviceName,
			remoteId,
			st ? st.mtime : Date.now()
		);
		await this.setBaseFromData(path, data, entry.id);
	}

	private async setBaseFromData(path: string, data: ArrayBuffer, remoteId: string) {
		const hash = md5(data);
		this.state.base[path] = { hash, remoteId };
		const st = await this.statLocal(path);
		if (st) {
			this.state.cache[path] = { mtime: st.mtime, size: st.size, hash };
		}
		if (this.keepsBaseText(path)) {
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
		if (this.isConfig(path)) {
			const adapter = this.vault.adapter;
			const parts = path.split("/").slice(0, -1);
			for (let i = 1; i <= parts.length; i++) {
				const dir = parts.slice(0, i).join("/");
				if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
			}
			await adapter.writeBinary(path, data);
			return;
		}
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

	/** Removes folders like .obsidian/plugins/xyz that became empty (never .obsidian itself). */
	private async removeEmptyConfigParents(path: string) {
		const adapter = this.vault.adapter;
		let dir = path.slice(0, path.lastIndexOf("/"));
		while (dir.length > this.vault.configDir.length && dir.startsWith(this.configPrefix)) {
			try {
				const l = await adapter.list(dir);
				if (l.files.length || l.folders.length) return;
				await adapter.rmdir(dir, false);
			} catch {
				return;
			}
			dir = dir.slice(0, dir.lastIndexOf("/"));
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
