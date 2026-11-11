/**
 * Safety checks for paths and names that come from Google Drive.
 *
 * The file name in Drive is used as the path inside the vault. Anything that
 * can write to the Drive folder could therefore try to make this device write
 * outside the vault or into Obsidian's settings folder. Every path (local and
 * remote, so both sides stay symmetric) has to pass `isSafeSyncPath`.
 */

const MAX_PATH_LENGTH = 1000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Windows short names ("OBSIDI~1") are aliases for other folders/files. */
const SHORT_NAME = /^[^ .]{1,8}(\.[^ .]{0,3})?$/;

/**
 * How the file system may see a path segment: Windows and macOS ignore case,
 * macOS normalises Unicode, Windows drops trailing dots and spaces.
 */
export function canonicalSegment(segment: string): string {
	return segment.normalize("NFC").toLowerCase().replace(/[ .]+$/, "");
}

function isShortName(segment: string): boolean {
	return /~\d/.test(segment) && SHORT_NAME.test(segment);
}

/**
 * @param path       vault-relative path, "/" separated
 * @param configDir  Obsidian's settings folder, usually ".obsidian"
 * @returns false for anything that could leave the vault or reach a hidden
 *          folder other than the settings folder itself.
 */
export function isSafeSyncPath(path: string, configDir: string): boolean {
	if (typeof path !== "string" || !path || path.length > MAX_PATH_LENGTH) return false;
	if (CONTROL.test(path) || path.includes("\\") || path.startsWith("/")) return false;
	const inConfig = path.startsWith(configDir + "/");
	const parts = path.split("/");
	for (let i = 0; i < parts.length; i++) {
		const canon = canonicalSegment(parts[i]);
		// "", ".", "..", "...", " " … -> could climb out of the vault
		if (!canon) return false;
		if (isShortName(parts[i])) return false;
		// Hidden folders/files are never part of the vault index. The only
		// hidden place that may be synchronised is the settings folder, and
		// only when it is spelled exactly like on this device.
		if (canon.startsWith(".") && !(inConfig && i === 0)) return false;
		// Windows alternate data streams ("main.js::$DATA") and drive letters.
		if (parts[i].includes(":")) return false;
	}
	return true;
}

/** Device names from Drive end up in file names, notes and the log. */
export function cleanDeviceName(name: unknown): string | undefined {
	if (typeof name !== "string") return undefined;
	// eslint-disable-next-line no-control-regex
	const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[[\]<>`*_|#\\/]/g, "").trim();
	return clean.slice(0, 60) || undefined;
}
