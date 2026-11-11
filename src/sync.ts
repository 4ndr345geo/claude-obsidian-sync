import { App, normalizePath, TAbstractFile, TFile, TFolder } from "obsidian";
import SparkMD5 from "spark-md5";
import { DriveClient, DriveError } from "./drive";
import { ConfigSyncOptions, makeConfigFilter } from "./config";
import { conflictPath, isMergeable, mergeJson, mergeText } from "./merge";
import { BackupOptions, BackupStore } from "./backup";
import { Failures, FailureTracker, fingerprint } from "./isolation";
import { isSafeSyncPath } from "./paths";
import { Action, BaseEntry, LocalEntry, planSync, RemoteEntry } from "./plan";

export interface SyncState {
	base: Record<string, BaseEntry>;
	/** Hash cache so unchanged files don't need to be re-read on every sync. */
	cache: Record<string, { mtime: number; size: number; hash: string }>;
	folderId: string;
	folderName: string;
	/** Files that failed and are held back for a while (per-file fault isolation). */
	failures?: Failures;
	/** Last clean-up of the backup folder (ms) */
	lastBackupPrune?: number;
}

export interface SyncSettingsView {
	folderName: string;
	deviceName: string;
	excludes: string[];
	config: ConfigSyncOptions;
	backup: BackupOptions;
	/** Files whose previous version is not worth a backup (e.g. the sync logs) */
	skipBackup?: (path: string) => boolean;
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
	/** Files held back in this run because they failed recently (see isolation.ts). */
	held: number;
	/** Previous versions saved to the local backup folder before they were replaced or deleted */
	backedUp: number;
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

interface ScanContext {
	excluded: (p: string) => boolean;
	tracker: FailureTracker;
	localStat: Map<string, { mtime: number; size: number }>;
	remoteMd5: Map<string, string[]>;
	fileFailed: (path: string, e: unknown, kind: "read", fp: string, folder?: boolean) => void;
	out: Map<string, LocalEntry>;
}

/**
 * Decodes both versions of a note strictly as UTF-8.
 * @returns null if one of them is not valid text (it would be damaged by a merge)
 */
export function decodeStrict(a: ArrayBuffer, b: ArrayBuffer): [string, string] | null {
	try {
		const dec = new TextDecoder("utf-8", { fatal: true });
		return [dec.decode(a), dec.decode(b)];
	} catch {
		return null;
	}
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
	readonly backups: BackupStore;

	constructor(
		private app: App,
		private drive: DriveClient,
		private state: SyncState,
		private settings: () => SyncSettingsView,
		private baseDir: string,
		private persist: () => Promise<void>,
		private ownPluginId = "gdrive-vault-sync"
	) {
		this.backups = new BackupStore(
			this.app.vault.adapter as never,
			normalizePath(baseDir).replace(/\/base$/, "") + "/backups",
			() => this.settings().backup
		);
	}

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
	/**
	 * @param allowMassDelete  the user confirmed that many deletions are intended
	 * @param retryFailed      try files that failed recently right away (manual sync)
	 */
	async run(onProgress?: (msg: string) => void, allowMassDelete = false, retryFailed = false): Promise<SyncResult> {
		const s = this.settings();
		const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, merged: 0, marked: [], conflicts: [], errors: [], configChanged: false, events: [], held: 0, backedUp: 0 };
		this.backups.beginRun();
		this.state.failures ??= {};
		const tracker = new FailureTracker(this.state.failures, retryFailed);
		/** Reports a failure of one file; a problem that just repeats itself is not reported again. */
		const fileFailed = (path: string, e: unknown, kind: Parameters<FailureTracker["fail"]>[2], fp: string, folder = false) => {
			const msg = (e as Error)?.message ?? String(e);
			const k = e instanceof DriveError ? e.kind : kind;
			if (tracker.fail(path, msg, k, fp, folder)) {
				result.errors.push(`${path}: ${msg}`);
				result.events.push({ kind: "error", path, detail: msg });
			}
		};

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

		const remoteMd5 = new Map<string, string[]>();
		for (const r of remoteFiltered) remoteMd5.set(r.path, [...(remoteMd5.get(r.path) ?? []), r.md5]);
		/** Current fingerprint of a path (local state + remote checksums). */
		const localStat = new Map<string, { mtime: number; size: number }>();
		const fpOf = (path: string) => fingerprint(localStat.get(path) ?? null, remoteMd5.get(path) ?? []);

		onProgress?.("Prüfe lokale Dateien …");
		const scan: ScanContext = { excluded, tracker, localStat, remoteMd5, fileFailed, out: new Map() };
		await this.scanLocal(scan);
		if (s.config.enabled) await this.scanConfig(this.vault.configDir, scan);
		const local = scan.out;

		// Held-back paths (failed recently, or unreadable right now) take no part
		// in this run at all: not here, not in Drive, not in the base. So they can
		// neither be overwritten nor be mistaken for deleted.
		for (const path of remoteMd5.keys()) tracker.isHeld(path, fpOf(path));
		for (const path of Object.keys(this.state.base)) {
			if (!local.has(path) && !remoteMd5.has(path)) continue;
			tracker.isHeld(path, fpOf(path));
		}
		const held = (p: string) => tracker.held.has(p);
		for (const p of tracker.held) local.delete(p);
		const remotePlan = remoteFiltered.filter((r) => !held(r.path));
		const basePlan = Object.fromEntries(Object.entries(this.state.base).filter(([p]) => !held(p)));
		result.held = tracker.held.size;

		const plan = planSync(local, remotePlan, basePlan);
		const work = plan.actions.filter((a) => a.type !== "setBase" && a.type !== "dropBase");
		let done = 0;

		// An emptied or replaced Drive folder (or an emptied vault) would look
		// like "everything was deleted on the other side". Stop before that.
		const delLocal = plan.actions.filter((a) => a.type === "deleteLocal").length;
		const delRemote = plan.actions.filter((a) => a.type === "deleteRemote").length;
		const total = Math.max(Object.keys(basePlan).length, local.size, remotePlan.length);
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
				await this.resolveDuplicate(dup, remotePlan, result);
			} catch (e) {
				if (e instanceof DriveError && e.scope === "sync") {
					await this.persist();
					throw e;
				}
				fileFailed(dup.path, e, "other", fpOf(dup.path));
			}
			recordEvents(result, before, dup.path, false);
		}

		// Storage full: uploads are pointless, but downloads and deletions still work.
		let uploadsBlocked: DriveError | null = null;
		let skippedUploads = 0;

		const notTried = new Set<string>();
		/** Files in a row whose transfer ran out of time – two in a row means: the connection is bad. */
		let slowInARow: string[] = [];
		for (const action of plan.actions) {
			if (uploadsBlocked && (action.type === "upload" || action.type === "conflict")) {
				skippedUploads++;
				notTried.add(action.path);
				continue;
			}
			try {
				if (action.type !== "setBase" && action.type !== "dropBase") {
					done++;
					onProgress?.(`Synchronisiere ${done}/${work.length} …`);
				}
				const before = snapshot(result);
				try {
					await this.execute(action, local, remoteById, result);
					slowInARow = [];
				} finally {
					recordEvents(result, before, action.path, action.type === "deleteLocal");
				}
			} catch (e) {
				if (e instanceof DriveError && e.kind === "quota") {
					uploadsBlocked = e;
					skippedUploads++;
					notTried.add(action.path);
					continue;
				}
				// Problems that concern everything (login, no connection, Google down,
				// rate limit): stop instead of failing once per file.
				if (e instanceof DriveError && e.scope === "sync") {
					await this.persist();
					throw e;
				}
				// Everything else concerns only this file: hold it back, go on with the rest.
				fileFailed(action.path, e, "other", fpOf(action.path));
				if (e instanceof DriveError && e.network) {
					slowInARow.push(action.path);
					if (slowInARow.length >= 2) {
						// Not the files, the connection: do not hold them back, stop the run.
						for (const p of slowInARow) tracker.succeed(p);
						await this.persist();
						throw new DriveError(
							"Die Verbindung zu Google ist zu langsam oder unterbrochen. Es wird später erneut versucht.",
							0,
							"timeout",
							"sync"
						);
					}
				} else slowInARow = [];
			}
			if (done % 25 === 0) await this.persist();
		}

		// Files that failed before and went through without error now are fine again.
		for (const [path, f] of Object.entries(this.state.failures)) {
			if (f.folder || held(path) || tracker.failed.has(path) || notTried.has(path)) continue;
			tracker.succeed(path);
		}
		// Records of folders/files that exist nowhere any more are dropped.
		tracker.prune(
			(p) =>
				local.has(p) || remoteMd5.has(p) || localStat.has(p) || p in this.state.base ||
				(this.state.failures![p]?.folder === true && s.config.enabled)
		);
		if (uploadsBlocked) {
			const msg = `${uploadsBlocked.message} – ${skippedUploads} Datei(en) nicht hochgeladen`;
			result.errors.unshift(msg);
			result.events.push({ kind: "error", path: "Google Drive", detail: msg });
		}

		result.backedUp = this.backups.count;
		// Clean up old backups a few times a day (never fails the sync).
		if (Date.now() - (this.state.lastBackupPrune ?? 0) > 6 * 3600_000) {
			try {
				await this.backups.prune();
				this.state.lastBackupPrune = Date.now();
			} catch (e) {
				console.warn("[Google Drive Sync] Alte Sicherungen konnten nicht entfernt werden", e);
			}
		}

		// Forget cache entries for files that are gone or no longer synchronised.
		for (const p of Object.keys(this.state.cache)) {
			if (local.has(p) || localStat.has(p)) continue;
			try {
				if (!(await this.statLocal(p))) delete this.state.cache[p];
			} catch {
				/* keep the entry; checked again next time */
			}
		}
		await this.persist();
		return result;
	}

	/**
	 * Hashes all vault files. A file that cannot be read is held back (see
	 * isolation.ts) instead of stopping the run or counting as deleted.
	 */
	private async scanLocal(c: ScanContext): Promise<void> {
		for (const file of this.vault.getFiles()) {
			if (c.excluded(file.path)) continue;
			const { mtime, size } = file.stat;
			c.localStat.set(file.path, { mtime, size });
			const fp = fingerprint({ mtime, size }, c.remoteMd5.get(file.path) ?? []);
			if (c.tracker.isHeld(file.path, fp)) continue;
			let cached = this.state.cache[file.path];
			if (!cached || cached.mtime !== mtime || cached.size !== size) {
				try {
					const data = await this.vault.readBinary(file);
					cached = { mtime, size, hash: md5(data) };
				} catch (e) {
					c.fileFailed(file.path, new Error(`Datei kann nicht gelesen werden: ${(e as Error)?.message ?? e}`), "read", fp);
					c.tracker.held.add(file.path);
					continue;
				}
				this.state.cache[file.path] = cached;
			}
			c.out.set(file.path, { path: file.path, hash: cached.hash, mtime });
		}
	}

	/**
	 * Recursively scans the settings folder (not part of Obsidian's file index).
	 * A folder or file that cannot be read is held back as a whole – skipping
	 * it silently would look as if its files had been deleted on this device.
	 */
	private async scanConfig(dir: string, c: ScanContext): Promise<void> {
		if (c.tracker.isFolderHeld(dir)) {
			this.holdFolder(dir, c);
			return;
		}
		let listing: { files: string[]; folders: string[] };
		try {
			if (!(await this.vault.adapter.exists(dir))) return;
			listing = await this.vault.adapter.list(dir);
		} catch (e) {
			c.fileFailed(dir, new Error(`Ordner kann nicht gelesen werden: ${(e as Error)?.message ?? e}`), "read", "folder", true);
			this.holdFolder(dir, c);
			return;
		}
		if (this.state.failures?.[dir]?.folder) c.tracker.succeed(dir);
		for (const path of listing.files) {
			if (c.excluded(path)) continue;
			let st: { type: string; mtime: number; size: number } | null;
			try {
				st = await this.vault.adapter.stat(path);
			} catch (e) {
				c.fileFailed(path, new Error(`Datei kann nicht gelesen werden: ${(e as Error)?.message ?? e}`), "read", fingerprint(null, c.remoteMd5.get(path) ?? []));
				c.tracker.held.add(path);
				continue;
			}
			if (!st || st.type !== "file") continue;
			c.localStat.set(path, { mtime: st.mtime, size: st.size });
			const fp = fingerprint(st, c.remoteMd5.get(path) ?? []);
			if (c.tracker.isHeld(path, fp)) continue;
			let cached = this.state.cache[path];
			if (!cached || cached.mtime !== st.mtime || cached.size !== st.size) {
				try {
					const data = await this.vault.adapter.readBinary(path);
					cached = { mtime: st.mtime, size: st.size, hash: md5(data) };
				} catch (e) {
					c.fileFailed(path, new Error(`Datei kann nicht gelesen werden: ${(e as Error)?.message ?? e}`), "read", fp);
					c.tracker.held.add(path);
					continue;
				}
				this.state.cache[path] = cached;
			}
			c.out.set(path, { path, hash: cached.hash, mtime: st.mtime });
		}
		for (const folder of listing.folders) {
			// Skip folders that can never contain synchronised files.
			if (folder === normalizePath(this.baseDir).replace(/\/base$/, "")) continue;
			await this.scanConfig(folder, c);
		}
	}

	/** Everything known below a held-back folder takes no part in this run. */
	private holdFolder(dir: string, c: ScanContext) {
		const prefix = dir + "/";
		for (const p of [...c.remoteMd5.keys(), ...Object.keys(this.state.base), ...Object.keys(this.state.cache)]) {
			if (p.startsWith(prefix)) c.tracker.held.add(p);
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
				// Keep a copy first: settings files are deleted for good, and Obsidian's
				// own setting may also delete notes permanently instead of using a trash.
				await this.backupCurrent(a.path);
				if (this.isConfig(a.path)) {
					if (await this.vault.adapter.exists(a.path)) await this.vault.adapter.remove(a.path);
					await this.removeEmptyConfigParents(a.path);
					r.configChanged = true;
				} else {
					const f = this.vault.getAbstractFileByPath(a.path);
					if (f) await this.trash(f);
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
		// Fallback: a note that is not valid UTF-8 text, or a merge that fails,
		// is handled like an image – both versions are kept, nothing is mangled.
		const texts = isMergeable(path) ? decodeStrict(localData, remoteData) : null;
		let m: ReturnType<typeof mergeText> | null = null;
		if (texts) {
			try {
				m = mergeText(
					texts[0],
					hasBase ? await this.readBaseText(path) : null,
					texts[1],
					{ label: this.settings().deviceName, time: file.stat.mtime },
					{ label: remote?.device ?? "anderes Gerät", time: remote?.modifiedTime ?? 0 }
				);
			} catch (e) {
				console.warn(`[Google Drive Sync] Zusammenführen von ${path} fehlgeschlagen, behalte beide Versionen`, e);
			}
		}
		if (texts && m) {
			const localText = texts[0];
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
		if (isMergeable(path)) {
			console.warn(`[Google Drive Sync] ${path}: kein gültiger UTF-8-Text oder nicht zusammenführbar – Konfliktkopie`);
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
		const data = await this.drive.download(id, remote?.size);
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

	/**
	 * Copies the current local version of `path` to the backup folder, unless
	 * it equals `next`. Throws if the copy fails – the file must then stay as it is.
	 */
	private async backupCurrent(path: string, next?: ArrayBuffer): Promise<void> {
		if (this.settings().skipBackup?.(path)) return;
		let current: ArrayBuffer | null;
		try {
			current = await this.readLocal(path);
			if (!current && !this.isConfig(path) && (await this.vault.adapter.exists(path))) {
				current = await this.vault.adapter.readBinary(path);
			}
		} catch (e) {
			throw new Error(`Bisherige Version kann nicht gesichert werden (nicht lesbar): ${(e as Error)?.message ?? e}`);
		}
		if (!current || (next && current.byteLength === next.byteLength && md5(current) === md5(next))) return;
		try {
			await this.backups.save(path, current);
		} catch (e) {
			throw new Error(`Sicherung der bisherigen Version fehlgeschlagen, Datei bleibt unverändert: ${(e as Error)?.message ?? e}`);
		}
	}

	/** Trash with fallbacks: Obsidian's setting → system trash → vault's .trash folder. */
	private async trash(f: TAbstractFile) {
		try {
			await this.app.fileManager.trashFile(f);
			return;
		} catch (e) {
			console.warn("[Google Drive Sync] Papierkorb nicht verfügbar, versuche Alternativen", e);
		}
		try {
			await this.vault.trash(f, true);
		} catch {
			await this.vault.trash(f, false);
		}
	}

	private async writeLocal(path: string, data: ArrayBuffer): Promise<void> {
		await this.backupCurrent(path, data);
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
		try {
			await this.vault.createBinary(path, data);
		} catch (e) {
			// Fallback: the file exists on disk but Obsidian has not indexed it yet
			// (e.g. just created by another app). Write it directly; it was backed up above.
			if (!(await this.vault.adapter.exists(path))) throw e;
			await this.vault.adapter.writeBinary(path, data);
		}
	}

	/**
	 * Puts a backed-up version back in place. The version it replaces is backed
	 * up first, so a restore can be undone the same way.
	 */
	async restore(backupPath: string, original: string): Promise<void> {
		if (!isSafeSyncPath(original, this.vault.configDir)) throw new Error("Ungültiger Pfad.");
		const data = await this.backups.read(backupPath);
		this.backups.beginRun();
		await this.writeLocal(original, data);
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
