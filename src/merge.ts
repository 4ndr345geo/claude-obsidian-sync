import { diff3Merge, diffComm } from "node-diff3";

/**
 * Three-way merge for Markdown notes and Obsidian Canvas files.
 *
 *  - Uncritical changes (different places in the note were edited on each
 *    device, or both devices made the identical change) are combined
 *    automatically.
 *  - Critical changes (the same lines were changed differently on both
 *    devices) are kept side by side and marked in the note, so nothing is
 *    lost and you decide which version stays.
 *
 * The marking is Markdown-aware:
 *  - normal text      -> an Obsidian callout `> [!warning] Sync-Konflikt` (or `> [!warning] Sync Conflict`)
 *  - inside a code block -> classic text markers (a callout would not render there)
 *  - inside YAML frontmatter -> the newer value is kept (so properties stay
 *    valid) or optionally merged key-by-key, and conflicting keys shown below.
 *  - Obsidian Canvas (.canvas) -> JSON nodes and edges merged by unique IDs.
 */

export interface MergeSide {
	/** Device name, e.g. "Laptop" */
	label: string;
	/** Time of the last edit on that side (ms) */
	time: number;
}

export interface MergeOptions {
	/** Language for callouts: "de" or "en" */
	lang?: "de" | "en";
	/** When true, merges YAML frontmatter properties key-by-key */
	granularFrontmatter?: boolean;
}

export interface MergeOutcome {
	/** true = no critical changes, everything combined automatically */
	clean: boolean;
	/** number of marked critical spots */
	conflicts: number;
	text: string;
}

export const CONFLICT_CALLOUT_DE = "[!warning] Sync-Konflikt";
export const CONFLICT_CALLOUT_EN = "[!warning] Sync Conflict";
export const CONFLICT_CALLOUT = CONFLICT_CALLOUT_DE;

export const MARKER_START = "<<<<<<< Sync-Konflikt";
const MARKER_MID = "=======";
const MARKER_END = ">>>>>>>";

/** Recognises notes that still contain unresolved conflict markings. */
export function hasConflictMarkers(text: string): boolean {
	return (
		text.includes(CONFLICT_CALLOUT_DE) ||
		text.includes(CONFLICT_CALLOUT_EN) ||
		text.includes(MARKER_START)
	);
}

function formatTime(ms: number): string {
	if (!ms) return "";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(
		d.getMinutes()
	)}`;
}

function sideTitle(s: MergeSide): string {
	const t = formatTime(s.time);
	return t ? `${s.label} · ${t}` : s.label;
}

function quote(lines: string[], lang: "de" | "en" = "de"): string[] {
	if (lines.length === 0) {
		return [lang === "en" ? "> *(deleted at this spot)*" : "> *(an dieser Stelle gelöscht)*"];
	}
	return lines.map((l) => (l === "" ? ">" : `> ${l}`));
}

function callout(
	first: MergeSide,
	firstLines: string[],
	second: MergeSide,
	secondLines: string[],
	hint: string,
	lang: "de" | "en" = "de"
): string[] {
	const tag = lang === "en" ? CONFLICT_CALLOUT_EN : CONFLICT_CALLOUT_DE;
	return [
		`> ${tag}`,
		`> ${hint}`,
		">",
		`> **${sideTitle(first)}**`,
		">",
		...quote(firstLines, lang),
		">",
		`> **${sideTitle(second)}**`,
		">",
		...quote(secondLines, lang),
	];
}

const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Three-way merge for Markdown notes.
 *
 * @param local  current text on this device
 * @param base   text at the last successful sync (null = unknown)
 * @param remote current text in Google Drive
 * @param localSide info about local device
 * @param remoteSide info about remote device
 * @param options optional language and frontmatter settings
 */
export function mergeText(
	local: string,
	base: string | null,
	remote: string,
	localSide: MergeSide = { label: "Dieses Gerät", time: 0 },
	remoteSide: MergeSide = { label: "Anderes Gerät", time: 0 },
	options: MergeOptions = {}
): MergeOutcome {
	const lang = options.lang ?? "de";
	const nl = (s: string) => s.replace(/\r\n/g, "\n");
	local = nl(local);
	remote = nl(remote);

	if (local === remote) return { clean: true, conflicts: 0, text: local };

	if (base !== null) {
		base = nl(base);
		if (local === base) return { clean: true, conflicts: 0, text: remote };
		if (remote === base) return { clean: true, conflicts: 0, text: local };
	}

	const a = local.split("\n");
	const b = remote.split("\n");

	// Without a known base (e.g. the same note was created on two devices),
	// use the lines both versions share as the base.
	const o =
		base !== null
			? base.split("\n")
			: diffComm(a, b).flatMap((c) => ("common" in c ? (c.common as string[]) : []));

	const regions = diff3Merge(a, o, b, { excludeFalseConflicts: true } as never);

	const localFirst = localSide.time >= remoteSide.time;
	const [first, second] = localFirst ? [localSide, remoteSide] : [remoteSide, localSide];

	const out: string[] = [];
	const deferred: string[][] = [];
	const st = { fm: "none" as "none" | "open" | "closed" };
	let inFence = false;
	let conflicts = 0;

	const push = (line: string) => {
		const idx = out.length;
		out.push(line);
		if (st.fm === "none" && idx === 0 && line === "---") {
			st.fm = "open";
			return;
		}
		if (st.fm === "open") {
			if (idx > 0 && line === "---") {
				st.fm = "closed";
				for (const block of deferred) {
					out.push("", ...block);
				}
				if (deferred.length) out.push("");
				deferred.length = 0;
			}
			return;
		}
		if (FENCE.test(line)) inFence = !inFence;
	};

	const conflictHint =
		lang === "en"
			? "This section was modified differently on two devices. Keep the desired version and delete this callout."
			: "Diese Stelle wurde auf zwei Geräten unterschiedlich geändert. Behalte die richtige Version und lösche diesen Kasten.";

	const frontmatterHint =
		lang === "en"
			? "In properties (frontmatter), the newer version was kept. Please check and delete this callout."
			: "In den Eigenschaften (Frontmatter) wurde die neuere Version übernommen. Bitte prüfen und diesen Kasten löschen.";

	for (const region of regions) {
		if (region.ok) {
			for (const l of region.ok) push(l);
			continue;
		}
		if (!region.conflict) continue;

		conflicts++;
		const aLines = region.conflict.a as string[];
		const bLines = region.conflict.b as string[];
		const firstLines = localFirst ? aLines : bLines;
		const secondLines = localFirst ? bLines : aLines;

		const atStart = out.length === 0 && (firstLines[0] === "---" || secondLines[0] === "---");

		if (st.fm === "open" || atStart) {
			// Keep YAML valid: newer value stays, other value is shown below the frontmatter.
			deferred.push(callout(first, firstLines, second, secondLines, frontmatterHint, lang));
			for (const l of firstLines) push(l);
		} else if (inFence) {
			for (const l of [
				`${MARKER_START} ${sideTitle(first)}`,
				...firstLines,
				MARKER_MID,
				...secondLines,
				`${MARKER_END} ${sideTitle(second)}`,
			]) {
				out.push(l); // markers never toggle fence state
			}
		} else {
			if (out.length && out[out.length - 1].trim() !== "") out.push("");
			out.push(...callout(first, firstLines, second, secondLines, conflictHint, lang));
			out.push(""); // end callout
		}
	}

	// Frontmatter never closed -> append remaining notes at the end.
	for (const block of deferred) out.push("", ...block);

	return { clean: conflicts === 0, conflicts, text: out.join("\n") };
}

/**
 * Granular Key-by-Key YAML Frontmatter Merge.
 * Combines disjoint keys cleanly, only creating conflicts when identical keys have distinct edits.
 */
export function mergeFrontmatterGranular(
	localFm: string,
	baseFm: string | null,
	remoteFm: string,
	localNewer: boolean
): { text: string; clean: boolean; conflictKeys: string[] } {
	const parseLines = (s: string) => {
		const map: Record<string, string> = {};
		for (const l of s.split("\n")) {
			const idx = l.indexOf(":");
			if (idx > 0) {
				map[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
			}
		}
		return map;
	};

	const lKeys = parseLines(localFm);
	const rKeys = parseLines(remoteFm);
	const bKeys = baseFm !== null ? parseLines(baseFm) : {};

	const allKeys = [...new Set([...Object.keys(lKeys), ...Object.keys(rKeys)])];
	const merged: Record<string, string> = {};
	const conflictKeys: string[] = [];

	for (const k of allKeys) {
		const l = lKeys[k];
		const r = rKeys[k];
		const b = bKeys[k];

		if (l !== undefined && r !== undefined) {
			if (l === r) {
				merged[k] = l;
			} else if (b !== undefined && l === b) {
				merged[k] = r;
			} else if (b !== undefined && r === b) {
				merged[k] = l;
			} else {
				// Both modified differently
				conflictKeys.push(k);
				merged[k] = localNewer ? l : r;
			}
		} else if (l !== undefined) {
			if (b === undefined || l !== b) merged[k] = l;
		} else if (r !== undefined) {
			if (b === undefined || r !== b) merged[k] = r;
		}
	}

	const lines = ["---"];
	for (const [k, v] of Object.entries(merged)) {
		lines.push(`${k}: ${v}`);
	}
	lines.push("---");

	return {
		text: lines.join("\n"),
		clean: conflictKeys.length === 0,
		conflictKeys,
	};
}

const TEXT_EXTENSIONS = new Set(["md", "txt", "markdown", "canvas"]);

export function isMergeable(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return TEXT_EXTENSIONS.has(ext);
}

/** "Ordner/Notiz.md" -> "Ordner/Notiz (Konflikt Laptop 2026-11-03 14-05).md" */
export function conflictPath(path: string, device: string, date = new Date()): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const file = path.slice(slash + 1);
	const dot = file.lastIndexOf(".");
	const name = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot) : "";
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
		date.getHours()
	)}-${pad(date.getMinutes())}`;
	const safeDevice = device.replace(/[\\/:*?"<>|]/g, "").trim() || "anderes Gerät";
	return `${dir}${name} (Konflikt ${safeDevice} ${stamp})${ext}`;
}

// ---------------------------------------------------------------------------
// Settings files (.obsidian/*.json): three-way merge per setting (key).
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPlainObject(v: unknown): v is Record<string, Json> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o: Record<string, Json>, k: string): Json | undefined => (own(o, k) ? o[k] : undefined);

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function merge3(local: Json | undefined, base: Json | undefined, remote: Json | undefined, localNewer: boolean): Json | undefined {
	if (deepEqual(local, remote)) return local;
	if (deepEqual(local, base)) return remote;
	if (deepEqual(remote, base)) return local;
	if (isPlainObject(local) && isPlainObject(remote)) {
		const b = isPlainObject(base) ? base : undefined;
		const out: Record<string, Json> = Object.create(null);
		const keys = [...Object.keys(local), ...Object.keys(remote).filter((k) => !own(local, k))];
		for (const k of keys) {
			const v = merge3(get(local, k), b ? get(b, k) : undefined, get(remote, k), localNewer);
			if (v !== undefined) out[k] = v;
		}
		return out;
	}
	return localNewer ? local : remote;
}

export function mergeJson(local: string, base: string | null, remote: string, localNewer: boolean): string | null {
	let l: Json, r: Json, b: Json | undefined;
	try {
		l = JSON.parse(local);
		r = JSON.parse(remote);
	} catch {
		return null;
	}
	try {
		b = base !== null ? JSON.parse(base) : undefined;
	} catch {
		b = undefined;
	}
	const merged = merge3(l, b, r, localNewer);
	return JSON.stringify(merged ?? {}, null, 2);
}

// ---------------------------------------------------------------------------
// Obsidian Canvas (.canvas) Three-Way Merge Engine
// ---------------------------------------------------------------------------

export interface CanvasNode {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	type?: string;
	text?: string;
	file?: string;
	url?: string;
	color?: string;
	[key: string]: unknown;
}

export interface CanvasEdge {
	id: string;
	fromNode: string;
	fromSide?: string;
	toNode: string;
	toSide?: string;
	label?: string;
	color?: string;
	[key: string]: unknown;
}

export interface CanvasData {
	nodes?: CanvasNode[];
	edges?: CanvasEdge[];
	[key: string]: unknown;
}

/**
 * Three-way merge for Obsidian Canvas (.canvas) JSON files.
 * Reconciles nodes and edges by their unique ID, preserving independent mindmap edits.
 */
export function mergeCanvas(
	local: string,
	base: string | null,
	remote: string,
	localNewer: boolean
): string | null {
	let l: CanvasData, r: CanvasData, b: CanvasData | null = null;
	try {
		l = JSON.parse(local);
		r = JSON.parse(remote);
		if (base !== null) b = JSON.parse(base);
	} catch {
		return null;
	}

	// Merge nodes by ID
	const baseNodes = new Map<string, CanvasNode>((b?.nodes ?? []).map((n) => [n.id, n]));
	const localNodes = new Map<string, CanvasNode>((l.nodes ?? []).map((n) => [n.id, n]));
	const remoteNodes = new Map<string, CanvasNode>((r.nodes ?? []).map((n) => [n.id, n]));

	const mergedNodes: CanvasNode[] = [];
	const allNodeIds = new Set([...localNodes.keys(), ...remoteNodes.keys()]);

	for (const id of allNodeIds) {
		const lNode = localNodes.get(id);
		const rNode = remoteNodes.get(id);
		const bNode = baseNodes.get(id);

		if (lNode && rNode) {
			if (deepEqual(lNode, rNode)) {
				mergedNodes.push(lNode);
			} else if (bNode && deepEqual(lNode, bNode)) {
				// Local untouched, remote changed
				mergedNodes.push(rNode);
			} else if (bNode && deepEqual(rNode, bNode)) {
				// Remote untouched, local changed
				mergedNodes.push(lNode);
			} else {
				// Both modified: localNewer decides
				mergedNodes.push(localNewer ? lNode : rNode);
			}
		} else if (lNode && !rNode) {
			// In local, missing in remote
			if (!bNode || !deepEqual(lNode, bNode)) {
				mergedNodes.push(lNode); // Newly added locally or edited vs deleted
			}
		} else if (!lNode && rNode) {
			// In remote, missing in local
			if (!bNode || !deepEqual(rNode, bNode)) {
				mergedNodes.push(rNode);
			}
		}
	}

	// Merge edges by ID
	const baseEdges = new Map<string, CanvasEdge>((b?.edges ?? []).map((e) => [e.id, e]));
	const localEdges = new Map<string, CanvasEdge>((l.edges ?? []).map((e) => [e.id, e]));
	const remoteEdges = new Map<string, CanvasEdge>((r.edges ?? []).map((e) => [e.id, e]));

	const mergedEdges: CanvasEdge[] = [];
	const allEdgeIds = new Set([...localEdges.keys(), ...remoteEdges.keys()]);

	for (const id of allEdgeIds) {
		const lEdge = localEdges.get(id);
		const rEdge = remoteEdges.get(id);
		const bEdge = baseEdges.get(id);

		if (lEdge && rEdge) {
			if (deepEqual(lEdge, rEdge)) {
				mergedEdges.push(lEdge);
			} else if (bEdge && deepEqual(lEdge, bEdge)) {
				mergedEdges.push(rEdge);
			} else if (bEdge && deepEqual(rEdge, bEdge)) {
				mergedEdges.push(lEdge);
			} else {
				mergedEdges.push(localNewer ? lEdge : rEdge);
			}
		} else if (lEdge && !rEdge) {
			if (!bEdge || !deepEqual(lEdge, bEdge)) {
				mergedEdges.push(lEdge);
			}
		} else if (!lEdge && rEdge) {
			if (!bEdge || !deepEqual(rEdge, bEdge)) {
				mergedEdges.push(rEdge);
			}
		}
	}

	const out: CanvasData = {
		...r,
		...l,
		nodes: mergedNodes,
		edges: mergedEdges,
	};

	return JSON.stringify(out, null, 2);
}
