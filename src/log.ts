import type { SyncEvent, SyncResult } from "./sync";

/**
 * Sync log as a note per device: "<folder>/<device>.md".
 * Only that device writes its file, so there are never conflicts.
 * Newest entries on top; old entries are removed automatically.
 */

export const LOG_MAX_LINES = 500;
const MAX_FILES_PER_ENTRY = 25;

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDateTime(d: Date): string {
	return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(
		d.getMinutes()
	)}:${pad(d.getSeconds())}`;
}

export function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Gerät";
}

export function logPath(folder: string, device: string): string {
	return `${folder.replace(/^\/+|\/+$/g, "")}/${safeFileName(device)}.md`;
}

/** True for files inside the log folder (all devices' logs). */
export function makeLogMatcher(folder: string) {
	const prefix = folder.replace(/^\/+|\/+$/g, "") + "/";
	return (path: string) => path.startsWith(prefix);
}

const LABEL: Record<SyncEvent["kind"], string> = {
	up: "↑ hochgeladen",
	down: "↓ heruntergeladen",
	delLocal: "🗑 hier gelöscht (auf anderem Gerät gelöscht)",
	delRemote: "🗑 in Google Drive gelöscht",
	merged: "🔀 automatisch zusammengeführt",
	marked: "⚠ Konflikt in der Notiz markiert",
	copy: "⚠ Konfliktkopie angelegt",
	error: "❌ Fehler",
};

/**
 * Text from outside (file names from Google Drive, error messages) is shown as
 * inline code, where Markdown and HTML are not interpreted. So a file name
 * cannot place links, images or HTML in the log note.
 */
export function code(text: string): string {
	// eslint-disable-next-line no-control-regex
	const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/`/g, "'").trim();
	return `\`${clean.slice(0, 300) || " "}\``;
}

function link(path: string): string {
	// Wiki links for notes so they can be opened from the log; plain code for everything else.
	const plain = !/[[\]|#^<>`\\]/.test(path);
	if (plain && path.endsWith(".md") && !path.startsWith(".")) return `[[${path.slice(0, -3)}]]`;
	return code(path);
}

/**
 * Builds one log entry. Returns null if nothing worth logging happened
 * (transfers of log files themselves are ignored, otherwise the devices would
 * keep triggering each other).
 */
export function formatEntry(
	start: Date,
	durationMs: number,
	result: SyncResult | null,
	fatalError: string | null,
	isLogFile: (path: string) => boolean
): string | null {
	const events = (result?.events ?? []).filter((e) => !isLogFile(e.path));
	if (!fatalError && events.length === 0 && !(result?.errors.length)) return null;

	const failed = !!fatalError || events.some((e) => e.kind === "error");
	const secs = (durationMs / 1000).toFixed(1).replace(".", ",");
	const lines = [`## ${formatDateTime(start)} · ${failed ? "❌" : "✓"} ${secs} s`];

	if (fatalError) lines.push(`- ❌ Synchronisierung abgebrochen: ${code(fatalError)}`);

	const count = (k: SyncEvent["kind"]) => events.filter((e) => e.kind === k).length;
	const summary = [
		["↑", count("up")],
		["↓", count("down")],
		["🗑", count("delLocal") + count("delRemote")],
		["🔀", count("merged")],
		["⚠", count("marked") + count("copy")],
		["❌", count("error")],
		["⏸", result?.held ?? 0],
	]
		.filter(([, n]) => n)
		.map(([s, n]) => `${s} ${n}`);
	if (summary.length) lines.push(`- ${summary.join(" · ")}`);

	// Most important first: errors, conflicts, then the rest.
	const order: SyncEvent["kind"][] = ["error", "marked", "copy", "merged", "delLocal", "delRemote", "down", "up"];
	const sorted = [...events].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
	for (const e of sorted.slice(0, MAX_FILES_PER_ENTRY)) {
		let line = `- ${LABEL[e.kind]}: ${link(e.path)}`;
		if (e.kind === "copy" && e.detail) line += ` (von ${link(e.detail)})`;
		if (e.kind === "error" && e.detail) line += ` – ${code(e.detail)}`;
		lines.push(line);
	}
	if (sorted.length > MAX_FILES_PER_ENTRY) lines.push(`- … und ${sorted.length - MAX_FILES_PER_ENTRY} weitere`);
	if (result?.configChanged) lines.push("- ⚙ Einstellungen übernommen (Obsidian neu laden)");
	if (result?.held) {
		lines.push(`- ⏸ ${result.held} Datei(en) nach einem Fehler zurückgestellt, nächster Versuch automatisch (Befehl „Dateien mit Sync-Fehlern anzeigen“)`);
	}
	return lines.join("\n");
}

function header(device: string): string {
	return (
		`# Sync-Protokoll – ${device}\n\n` +
		`> Neueste Einträge oben. Diese Datei schreibt nur das Gerät „${device}“. ` +
		`Ältere Einträge werden automatisch entfernt. Einträge entstehen nur, wenn etwas übertragen wurde oder ein Fehler auftrat.\n`
	);
}

/** Puts the new entry on top and keeps at most maxLines lines of entries. */
export function addEntry(existing: string, entry: string, device: string, maxLines = LOG_MAX_LINES): string {
	const firstEntry = existing.indexOf("\n## ");
	const old = firstEntry >= 0 ? existing.slice(firstEntry + 1) : "";
	const entries = [entry, ...old.split(/\n(?=## )/).map((e) => e.trim()).filter(Boolean)];
	const kept: string[] = [];
	let lines = 0;
	for (const e of entries) {
		const n = e.split("\n").length + 1;
		if (kept.length && lines + n > maxLines) break;
		kept.push(e);
		lines += n;
	}
	return `${header(device)}\n${kept.join("\n\n")}\n`;
}
