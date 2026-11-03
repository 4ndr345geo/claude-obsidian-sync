import { diff3Merge, diffComm } from "node-diff3";

/**
 * Three-way merge for Markdown notes.
 *
 *  - Uncritical changes (different places in the note were edited on each
 *    device, or both devices made the identical change) are combined
 *    automatically.
 *  - Critical changes (the same lines were changed differently on both
 *    devices) are kept side by side and marked in the note, so nothing is
 *    lost and you decide which version stays.
 *
 * The marking is Markdown-aware:
 *  - normal text      -> an Obsidian callout `> [!warning] Sync-Konflikt`
 *  - inside a code block -> classic text markers (a callout would not render there)
 *  - inside YAML frontmatter -> the newer value is kept (so the properties stay
 *    valid) and the other value is shown in a callout directly below the
 *    frontmatter.
 */

export interface MergeSide {
	/** Device name, e.g. "Laptop" */
	label: string;
	/** Time of the last edit on that side (ms) */
	time: number;
}

export interface MergeOutcome {
	/** true = no critical changes, everything combined automatically */
	clean: boolean;
	/** number of marked critical spots */
	conflicts: number;
	text: string;
}

export const CONFLICT_CALLOUT = "[!warning] Sync-Konflikt";
export const MARKER_START = "<<<<<<< Sync-Konflikt";
const MARKER_MID = "=======";
const MARKER_END = ">>>>>>>";

/** Recognises notes that still contain unresolved conflict markings. */
export function hasConflictMarkers(text: string): boolean {
	return text.includes(CONFLICT_CALLOUT) || text.includes(MARKER_START);
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

function quote(lines: string[]): string[] {
	if (lines.length === 0) return ["> *(an dieser Stelle gelöscht)*"];
	return lines.map((l) => (l === "" ? ">" : `> ${l}`));
}

function callout(first: MergeSide, firstLines: string[], second: MergeSide, secondLines: string[], hint: string): string[] {
	return [
		`> ${CONFLICT_CALLOUT}`,
		`> ${hint}`,
		">",
		`> **${sideTitle(first)}**`,
		">",
		...quote(firstLines),
		">",
		`> **${sideTitle(second)}**`,
		">",
		...quote(secondLines),
	];
}

const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * @param local  current text on this device
 * @param base   text at the last successful sync (null = unknown)
 * @param remote current text in Google Drive
 */
export function mergeText(
	local: string,
	base: string | null,
	remote: string,
	localSide: MergeSide = { label: "Dieses Gerät", time: 0 },
	remoteSide: MergeSide = { label: "Anderes Gerät", time: 0 }
): MergeOutcome {
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
	// use the lines both versions share as the base: additions from either
	// side are kept, differing lines are marked.
	const o =
		base !== null
			? base.split("\n")
			: diffComm(a, b).flatMap((c) => ("common" in c ? (c.common as string[]) : []));

	const regions = diff3Merge(a, o, b, { excludeFalseConflicts: true } as never);

	// The more recently edited version is shown first and, in the frontmatter, wins.
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
			deferred.push(
				callout(first, firstLines, second, secondLines, "In den Eigenschaften (Frontmatter) wurde die neuere Version übernommen. Bitte prüfen und diesen Kasten löschen.")
			);
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
			out.push(
				...callout(first, firstLines, second, secondLines, "Diese Stelle wurde auf zwei Geräten unterschiedlich geändert. Behalte die richtige Version und lösche diesen Kasten.")
			);
			out.push(""); // end the callout, otherwise the next paragraph would continue it
		}
	}
	// Frontmatter never closed -> append remaining notes at the end.
	for (const block of deferred) out.push("", ...block);

	return { clean: conflicts === 0, conflicts, text: out.join("\n") };
}

const TEXT_EXTENSIONS = new Set(["md", "txt", "markdown"]);

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
