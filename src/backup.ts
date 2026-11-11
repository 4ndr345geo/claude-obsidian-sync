/**
 * Local backups: before the sync overwrites or deletes a file on this device,
 * the previous version is copied to
 *   .obsidian/sync-history/<date>/<time>/<path in the vault>
 * One time folder per sync run. The folder is device-local (never synchronised),
 * is cleaned up automatically (age, total size, versions per file) and is kept
 * when the plugin is uninstalled. Version 1.6.0–1.7.0 kept the backups in the
 * plugin folder; they are moved here on first use.
 */

export interface BackupOptions {
	enabled: boolean;
	/** Backups older than this are removed */
	keepDays: number;
	/** Oldest backups are removed above this total size */
	maxTotalBytes: number;
	/** Larger files are not backed up (Google Drive keeps their old versions for 30 days) */
	maxFileBytes: number;
	/** At most this many versions per file; older ones are removed */
	maxVersionsPerFile?: number;
}

export interface BackupEntry {
	/** Path of the backup file */
	backupPath: string;
	/** Path of the original file in the vault */
	original: string;
	/** Time of the sync run (ms) */
	time: number;
	size: number;
}

/** The part of Obsidian's DataAdapter that is needed here. */
export interface BackupAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	stat(path: string): Promise<{ type: string; size: number; mtime: number } | null>;
	rmdir(path: string, recursive: boolean): Promise<void>;
	remove(path: string): Promise<void>;
	rename(path: string, newPath: string): Promise<void>;
}

const pad = (n: number, l = 2) => String(n).padStart(l, "0");
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}-\d{2}-\d{2}-\d{3}$/;

export function stampOf(d: Date): { day: string; time: string } {
	return {
		day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`,
	};
}

function parseStamp(day: string, time: string): number {
	const [y, mo, d] = day.split("-").map(Number);
	const [h, mi, s, ms] = time.split("-").map(Number);
	return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export class BackupStore {
	private run: { day: string; time: string } | null = null;
	/** Paths already backed up in this run – the first (oldest) version is the one to keep. */
	private saved = new Set<string>();
	/** Files not backed up because they were too large (for the log). */
	skipped = 0;
	count = 0;

	private migrated: Promise<void> | null = null;

	/**
	 * @param legacyDir earlier location of the backups; moved to `dir` once
	 */
	constructor(
		private adapter: BackupAdapter,
		readonly dir: string,
		private options: () => BackupOptions,
		private legacyDir?: string
	) {}

	/** Moves backups from the earlier location (once; never fails – old backups simply stay where they are). */
	ready(): Promise<void> {
		this.migrated ??= this.migrate().catch((e) =>
			console.warn("[Google Drive Sync] Alte Sicherungen konnten nicht verschoben werden", e)
		);
		return this.migrated;
	}

	private async migrate() {
		const old = this.legacyDir;
		if (!old || old === this.dir || !(await this.adapter.exists(old))) return;
		const files: string[] = [];
		await this.walk(old, async (f) => void files.push(f));
		for (const f of files) {
			const target = this.dir + f.slice(old.length);
			if (await this.adapter.exists(target)) continue; // keep both: the old copy stays
			await this.mkdirs(target.slice(0, target.lastIndexOf("/")));
			await this.adapter.rename(f, target);
		}
		const left: string[] = [];
		await this.walk(old, async (f) => void left.push(f));
		if (!left.length) await this.adapter.rmdir(old, true);
	}

	/** Starts a new time folder (one per sync run or restore). */
	beginRun(now = new Date()) {
		this.run = stampOf(now);
		this.saved.clear();
		this.skipped = 0;
		this.count = 0;
	}

	private async mkdirs(path: string) {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const d = parts.slice(0, i).join("/");
			if (await this.adapter.exists(d)) continue;
			try {
				await this.adapter.mkdir(d);
			} catch (e) {
				if (!(await this.adapter.exists(d))) throw e; // created in parallel: fine
			}
		}
	}

	/**
	 * Keeps a copy of the current version of `original`.
	 * @returns the backup path, or null if backups are off or the file is too large
	 * @throws  if the copy could not be written – the caller must then not change the file
	 */
	async save(original: string, data: ArrayBuffer): Promise<string | null> {
		await this.ready();
		const o = this.options();
		if (!o.enabled) return null;
		if (data.byteLength > o.maxFileBytes) {
			this.skipped++;
			return null;
		}
		if (!this.run) this.beginRun();
		const target = `${this.dir}/${this.run!.day}/${this.run!.time}/${original}`;
		if (this.saved.has(original)) return target;
		await this.mkdirs(target.slice(0, target.lastIndexOf("/")));
		await this.adapter.writeBinary(target, data);
		this.saved.add(original);
		this.count++;
		return target;
	}

	/** All backups, newest first. */
	async list(): Promise<BackupEntry[]> {
		await this.ready();
		const out: BackupEntry[] = [];
		if (!(await this.adapter.exists(this.dir))) return out;
		for (const dayDir of (await this.adapter.list(this.dir)).folders) {
			const day = base(dayDir);
			if (!DAY.test(day)) continue;
			for (const timeDir of (await this.adapter.list(dayDir)).folders) {
				const time = base(timeDir);
				if (!TIME.test(time)) continue;
				const t = parseStamp(day, time);
				await this.walk(timeDir, async (file) => {
					const st = await this.adapter.stat(file);
					out.push({ backupPath: file, original: file.slice(timeDir.length + 1), time: t, size: st?.size ?? 0 });
				});
			}
		}
		return out.sort((a, b) => b.time - a.time || a.original.localeCompare(b.original));
	}

	private async walk(dir: string, fn: (file: string) => Promise<void>) {
		const l = await this.adapter.list(dir);
		for (const f of l.files) await fn(f);
		for (const d of l.folders) await this.walk(d, fn);
	}

	read(backupPath: string): Promise<ArrayBuffer> {
		if (!backupPath.startsWith(this.dir + "/")) throw new Error("Keine Sicherung.");
		return this.adapter.readBinary(backupPath);
	}

	/**
	 * Removes backups older than keepDays, then the oldest runs until the total
	 * size is below the limit. The run in progress is never removed.
	 * @returns number of removed run folders
	 */
	async prune(now = Date.now()): Promise<number> {
		await this.ready();
		if (!(await this.adapter.exists(this.dir))) return 0;
		const o = this.options();
		// 1) Per file: keep only the newest versions.
		const perFile = o.maxVersionsPerFile ?? 50;
		const seen = new Map<string, number>();
		for (const e of await this.list()) {
			const n = (seen.get(e.original) ?? 0) + 1;
			seen.set(e.original, n);
			if (n > perFile) await this.adapter.remove(e.backupPath);
		}
		const runs: { dir: string; time: number; size: number }[] = [];
		const current = this.run ? `${this.dir}/${this.run.day}/${this.run.time}` : "";
		for (const dayDir of (await this.adapter.list(this.dir)).folders) {
			if (!DAY.test(base(dayDir))) continue;
			const timeDirs = (await this.adapter.list(dayDir)).folders.filter((d) => TIME.test(base(d)));
			if (!timeDirs.length) {
				await this.adapter.rmdir(dayDir, true);
				continue;
			}
			for (const timeDir of timeDirs) {
				let size = 0, files = 0;
				await this.walk(timeDir, async (f) => {
					size += (await this.adapter.stat(f))?.size ?? 0;
					files++;
				});
				if (!files && timeDir !== current) {
					await this.adapter.rmdir(timeDir, true);
					continue;
				}
				runs.push({ dir: timeDir, time: parseStamp(base(dayDir), base(timeDir)), size });
			}
		}
		runs.sort((a, b) => a.time - b.time);
		let total = runs.reduce((s, r) => s + r.size, 0);
		let removed = 0;
		for (const r of runs) {
			if (r.dir === current) continue;
			const tooOld = now - r.time > o.keepDays * 24 * 3600_000;
			if (!tooOld && total <= o.maxTotalBytes) continue;
			await this.adapter.rmdir(r.dir, true);
			total -= r.size;
			removed++;
		}
		return removed;
	}
}
