/**
 * Per-file fault isolation.
 *
 * A file (or a folder of the settings directory) that cannot be read, written
 * or transferred is "held back": it is taken out of the whole sync run – no
 * upload, no download, no deletion, its base stays untouched – while all other
 * files are synchronised normally. It is tried again
 *   - after a growing pause (1 min, 10 min, 1 h, then every 6 h),
 *   - immediately when the file changes here or in Google Drive,
 *   - immediately on a manual sync.
 * So one broken file neither blocks the others nor is retried and reported
 * every two minutes.
 */

import type { ErrorKind } from "./http";

export interface FailureEntry {
	/** Failed attempts in a row */
	count: number;
	/** Last error message (for the user) */
	error: string;
	kind: ErrorKind | "read" | "write" | "other";
	/** First failure (ms) */
	since: number;
	/** Not tried again before this time (ms) */
	nextTry: number;
	/** State of the file at the time of the failure – a change means "try again now". */
	fingerprint: string;
	/** true: a folder – everything below it is held back */
	folder?: boolean;
}

export type Failures = Record<string, FailureEntry>;

const MINUTE = 60_000;
const DELAYS = [1 * MINUTE, 10 * MINUTE, 60 * MINUTE, 6 * 60 * MINUTE];
/** Errors that will not go away by themselves: wait long right away (a change still retries at once). */
const PERMANENT = new Set<FailureEntry["kind"]>(["tooLarge", "badRequest", "forbidden", "blocked"]);

export function delayFor(count: number, kind: FailureEntry["kind"]): number {
	const d = DELAYS[Math.min(Math.max(count, 1), DELAYS.length) - 1];
	return PERMANENT.has(kind) ? DELAYS[DELAYS.length - 1] : d;
}

/**
 * What identifies the state of a path without reading it: local modification
 * time and size, and the checksums of the remote copies.
 */
export function fingerprint(local: { mtime: number; size: number } | null, remoteMd5s: string[]): string {
	return `${local ? `${local.mtime}:${local.size}` : "-"}|${[...remoteMd5s].sort().join(",")}`;
}

export class FailureTracker {
	/** Paths that failed in this run (reported or not). */
	readonly failed = new Set<string>();
	/** Paths held back in this run without being tried. */
	readonly held = new Set<string>();

	/**
	 * @param failures  persistent record (part of the sync state)
	 * @param retryAll  manual sync: try everything again now
	 */
	constructor(private failures: Failures, private retryAll: boolean, private now = Date.now()) {}

	/** Folder held back that contains this path (settings folder only). */
	private heldFolder(path: string): string | null {
		for (const [key, f] of Object.entries(this.failures)) {
			if (f.folder && path.startsWith(key + "/") && this.waiting(f, f.fingerprint)) return key;
		}
		return null;
	}

	private waiting(f: FailureEntry, current: string): boolean {
		return !this.retryAll && this.now < f.nextTry && f.fingerprint === current;
	}

	/** Should this path stay out of the current run? */
	isHeld(path: string, current: string): boolean {
		const f = this.failures[path];
		const held = (!!f && !f.folder && this.waiting(f, current)) || this.heldFolder(path) !== null;
		if (held) this.held.add(path);
		return held;
	}

	/** Is this folder held back as a whole? */
	isFolderHeld(folder: string): boolean {
		const f = this.failures[folder];
		return (!!f && !!f.folder && this.waiting(f, f.fingerprint)) || this.heldFolder(folder) !== null;
	}

	/** @returns true if this is a new or changed problem (worth reporting), false if it is the same as last time */
	fail(path: string, error: string, kind: FailureEntry["kind"], current: string, folder = false): boolean {
		const old = this.failures[path];
		const count = old && old.fingerprint === current ? old.count + 1 : 1;
		this.failures[path] = {
			count,
			error: error.slice(0, 300),
			kind,
			since: old?.since ?? this.now,
			nextTry: this.now + delayFor(count, kind),
			fingerprint: current,
			...(folder ? { folder: true } : {}),
		};
		this.failed.add(path);
		const repeated = !!old && old.error === this.failures[path].error && old.fingerprint === current;
		return !repeated;
	}

	succeed(path: string) {
		delete this.failures[path];
	}

	/** Forget records of paths that no longer exist anywhere. */
	prune(exists: (path: string) => boolean) {
		for (const key of Object.keys(this.failures)) if (!exists(key)) delete this.failures[key];
	}
}
