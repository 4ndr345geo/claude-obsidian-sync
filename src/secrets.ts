import type { App } from "obsidian";

/**
 * Keeps the Google credentials out of the vault folder.
 *
 * Obsidian 1.11.4+ has a keychain (`app.secretStorage`). When it is available
 * the client secret and the refresh token are stored there, and `data.json`
 * inside the vault only holds an empty string. That way the credentials are not
 * part of vault backups (ZIP), other sync tools or a git repository of the vault.
 *
 * Older Obsidian versions have no keychain: there the values stay in
 * `data.json` as before.
 */

export type SecretName = "client-secret" | "refresh-token";

interface SecretStorageLike {
	setSecret(id: string, secret: string): void;
	getSecret(id: string): string | null;
}

export class SecretStore {
	private storage: SecretStorageLike | null;
	private written = new Map<SecretName, string>();

	/** @param installId random id of this vault's installation (lowercase letters and digits) */
	constructor(app: App, private pluginId: string, private installId: string) {
		const s = (app as unknown as { secretStorage?: SecretStorageLike }).secretStorage;
		this.storage = s && typeof s.setSecret === "function" && typeof s.getSecret === "function" ? s : null;
	}

	get available(): boolean {
		return this.storage !== null;
	}

	private id(name: SecretName) {
		return `${this.pluginId}-${this.installId}-${name}`;
	}

	get(name: SecretName): string {
		try {
			return this.storage?.getSecret(this.id(name)) ?? "";
		} catch {
			return "";
		}
	}

	/**
	 * Stores a value and checks that it can be read back.
	 * @returns false if the keychain did not take it – the caller then keeps
	 *          the value in data.json so the connection is never lost.
	 */
	set(name: SecretName, value: string): boolean {
		if (!this.storage) return false;
		if (this.written.get(name) === value) return true;
		try {
			this.storage.setSecret(this.id(name), value);
			if ((this.storage.getSecret(this.id(name)) ?? "") !== value) return false;
			this.written.set(name, value);
			return true;
		} catch {
			return false;
		}
	}
}

export function newInstallId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
}
