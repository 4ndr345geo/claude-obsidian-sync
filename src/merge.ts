import { diff3Merge } from "node-diff3";

export interface MergeOutcome {
	clean: boolean;
	text: string;
}

/**
 * Line-based three-way merge. Returns clean=true when the changes from both
 * sides do not overlap and could be combined automatically.
 */
export function mergeText(local: string, base: string, remote: string): MergeOutcome {
	if (local === remote) return { clean: true, text: local };
	if (local === base) return { clean: true, text: remote };
	if (remote === base) return { clean: true, text: local };

	const split = (s: string) => s.replace(/\r\n/g, "\n").split("\n");
	const regions = diff3Merge(split(local), split(base), split(remote), {
		excludeFalseConflicts: true,
	} as never);

	const out: string[] = [];
	for (const region of regions) {
		if (region.ok) {
			out.push(...region.ok);
		} else if (region.conflict) {
			return { clean: false, text: local };
		}
	}
	return { clean: true, text: out.join("\n") };
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
