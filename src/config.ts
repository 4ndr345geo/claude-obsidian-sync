import { canonicalSegment } from "./paths";

/**
 * Which files inside the Obsidian settings folder (.obsidian) are synchronised.
 */

export interface ConfigSyncOptions {
	enabled: boolean;
	/** app.json, appearance.json, hotkeys.json, core plugins, bookmarks … */
	settings: boolean;
	/** themes/ and snippets/ */
	appearance: boolean;
	/** plugins/ (code and settings of community plugins) and community-plugins.json */
	plugins: boolean;
}

/** Device-specific files that are never synchronised. */
const NEVER = new Set(["workspace.json", "workspace-mobile.json", "workspaces.json"]);
const NEVER_SEGMENTS_CANON = new Set([".git", "node_modules", ".ds_store", "thumbs.db", ".hotreload"]);

/**
 * @param configDir  usually ".obsidian"
 * @param ownPluginId  this plugin's id – its folder holds device-specific state and secrets
 */
export function makeConfigFilter(configDir: string, ownPluginId: string, o: ConfigSyncOptions) {
	const prefix = configDir + "/";
	const own = canonicalSegment(ownPluginId);
	return (path: string): boolean => {
		if (!o.enabled || !path.startsWith(prefix)) return false;
		const rel = path.slice(prefix.length);
		// Compare the way a case-insensitive file system would, so that e.g.
		// "Plugins/GDrive-Vault-Sync" cannot be used to reach this plugin's folder.
		const parts = rel.split("/").map(canonicalSegment);
		if (parts.some((p) => !p || NEVER_SEGMENTS_CANON.has(p))) return false;
		if (parts.length === 1) {
			if (NEVER.has(parts[0]) || !parts[0].endsWith(".json")) return false;
			if (parts[0] === "community-plugins.json") return o.plugins;
			return o.settings;
		}
		if (parts[0] === "themes" || parts[0] === "snippets") return o.appearance;
		if (parts[0] === "plugins") return o.plugins && parts.length >= 3 && parts[1] !== own;
		return false;
	};
}
