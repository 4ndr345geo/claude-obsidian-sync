/**
 * Pure sync planning (three-way comparison).
 *
 * For every path we compare three states:
 *   L = current local content hash (md5)
 *   R = current remote content hash (Drive md5Checksum)
 *   B = hash of the content at the last successful sync ("base")
 *
 * Because local and remote both use md5, "changed since last sync" is a simple
 * hash comparison against B – no clock comparison is needed, so wrong device
 * clocks cannot cause data loss.
 */

export interface LocalEntry {
	path: string;
	hash: string;
	mtime: number;
}

export interface RemoteEntry {
	id: string;
	path: string;
	md5: string;
	modifiedTime: number;
	device?: string;
	/** Size in bytes, if known (sets the time limit of the download) */
	size?: number;
}

export interface BaseEntry {
	hash: string;
	remoteId: string;
}

export type Action =
	| { type: "upload"; path: string; remoteId?: string }
	| { type: "download"; path: string; remoteId: string }
	| { type: "deleteLocal"; path: string }
	| { type: "deleteRemote"; path: string; remoteId: string }
	| { type: "conflict"; path: string; remoteId: string; hasBase: boolean }
	| { type: "setBase"; path: string; hash: string; remoteId: string }
	| { type: "dropBase"; path: string };

export interface Plan {
	actions: Action[];
	/** Additional remote files with the same path (e.g. created simultaneously on two devices). */
	duplicates: RemoteEntry[];
}

export function planSync(
	local: Map<string, LocalEntry>,
	remoteList: RemoteEntry[],
	base: Record<string, BaseEntry>
): Plan {
	// Group remote by path; newest is primary, the rest are duplicates.
	const remote = new Map<string, RemoteEntry>();
	const duplicates: RemoteEntry[] = [];
	for (const r of remoteList) {
		const existing = remote.get(r.path);
		if (!existing) {
			remote.set(r.path, r);
			continue;
		}
		// Prefer the file we already track, otherwise the newest one.
		const trackedId = base[r.path]?.remoteId;
		const keepNew =
			r.id === trackedId ||
			(existing.id !== trackedId && r.modifiedTime > existing.modifiedTime);
		if (keepNew) {
			duplicates.push(existing);
			remote.set(r.path, r);
		} else {
			duplicates.push(r);
		}
	}

	const paths = new Set<string>([
		...local.keys(),
		...remote.keys(),
		...Object.keys(base),
	]);
	const actions: Action[] = [];

	for (const path of paths) {
		const l = local.get(path);
		const r = remote.get(path);
		const b = base[path];

		if (l && r) {
			if (l.hash === r.md5) {
				if (!b || b.hash !== l.hash || b.remoteId !== r.id) {
					actions.push({ type: "setBase", path, hash: l.hash, remoteId: r.id });
				}
				continue;
			}
			if (!b) {
				actions.push({ type: "conflict", path, remoteId: r.id, hasBase: false });
				continue;
			}
			const localChanged = l.hash !== b.hash;
			const remoteChanged = r.md5 !== b.hash;
			if (localChanged && remoteChanged) {
				actions.push({ type: "conflict", path, remoteId: r.id, hasBase: true });
			} else if (localChanged) {
				actions.push({ type: "upload", path, remoteId: r.id });
			} else if (remoteChanged) {
				actions.push({ type: "download", path, remoteId: r.id });
			} else {
				// Both equal to base but differ from each other – impossible; be safe.
				actions.push({ type: "conflict", path, remoteId: r.id, hasBase: true });
			}
		} else if (l && !r) {
			if (b && l.hash === b.hash) {
				// Unchanged here, deleted on another device -> delete here too.
				actions.push({ type: "deleteLocal", path });
			} else {
				// New here, or changed here after remote deletion -> keep it.
				actions.push({ type: "upload", path });
			}
		} else if (!l && r) {
			if (b && r.md5 === b.hash) {
				// Unchanged remotely, deleted here -> delete remote.
				actions.push({ type: "deleteRemote", path, remoteId: r.id });
			} else {
				// New remotely, or changed remotely after local deletion -> keep it.
				actions.push({ type: "download", path, remoteId: r.id });
			}
		} else if (b) {
			actions.push({ type: "dropBase", path });
		}
	}

	return { actions, duplicates };
}
