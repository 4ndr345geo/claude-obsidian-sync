import { Platform, requestUrl } from "obsidian";
import type { Credentials } from "./drive";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export type DriveScope = "drive" | "drive.file";

/** Sees all files in Google Drive, including files/folders created directly in Drive or by tools like Claude. */
export const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive";
/** Only files created by this plugin are visible to it – external Drive files remain invisible. */
export const SCOPE_DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
/** Default scope used for desktop OAuth authorization. */
export const SCOPE = SCOPE_DRIVE;

export function scopeUrl(mode: DriveScope): string {
	return mode === "drive.file" ? SCOPE_DRIVE_FILE : SCOPE_DRIVE;
}

function base64url(bytes: Uint8Array): string {
	let s = "";
	bytes.forEach((b) => (s += String.fromCharCode(b)));
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Desktop OAuth flow: opens the browser, receives the code on a temporary
 * local web server (127.0.0.1) and exchanges it for a refresh token.
 */
export async function authorizeDesktop(
	clientId: string,
	clientSecret: string,
	scope: string = SCOPE_DRIVE
): Promise<string> {
	if (!Platform.isDesktopApp) {
		throw new Error("Die Anmeldung ist nur am Computer möglich. Nutze auf dem Handy den Verbindungscode.");
	}
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const http = require("http") as typeof import("http");

	const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
	const challenge = base64url(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
	);
	const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

	const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
		(resolve, reject) => {
			const server = http.createServer((req, res) => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				if (url.pathname !== "/callback") {
					res.writeHead(404).end();
					return;
				}
				// Requests without our random state do not come from the login we
				// started: answer them, but keep waiting for the real one.
				if (req.method !== "GET" || url.searchParams.get("state") !== state) {
					res.writeHead(400).end();
					return;
				}
				const ok = !!url.searchParams.get("code");
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(
					ok
						? "<h2>Verbunden ✓</h2><p>Du kannst dieses Fenster schließen und zu Obsidian zurückkehren.</p>"
						: "<h2>Anmeldung fehlgeschlagen</h2><p>Bitte in Obsidian erneut versuchen.</p>"
				);
				clearTimeout(timer);
				server.close();
				if (ok) resolve({ code: url.searchParams.get("code")!, redirectUri });
				else reject(new Error(url.searchParams.get("error") ?? "Anmeldung abgebrochen"));
			});
			let redirectUri = "";
			const timer = setTimeout(() => {
				server.close();
				reject(new Error("Zeitüberschreitung bei der Anmeldung."));
			}, 5 * 60_000);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				const port = typeof addr === "object" && addr ? addr.port : 0;
				redirectUri = `http://127.0.0.1:${port}/callback`;
				const params = new URLSearchParams({
					client_id: clientId,
					redirect_uri: redirectUri,
					response_type: "code",
					scope,
					access_type: "offline",
					prompt: "consent",
					code_challenge: challenge,
					code_challenge_method: "S256",
					state,
				});
				window.open(`${AUTH_URL}?${params.toString()}`);
			});
			server.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		}
	);

	const res = await requestUrl({
		url: TOKEN_URL,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
		}).toString(),
		throw: false,
	});
	if (res.status !== 200 || !res.json.refresh_token) {
		throw new Error(`Token-Austausch fehlgeschlagen (${res.status}).`);
	}
	return res.json.refresh_token;
}

const CODE_PREFIX_V1 = "ODS1:";
const CODE_PREFIX_V2 = "ODS2:";
const PBKDF2_ITERATIONS = 150_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AAD_V2 = new TextEncoder().encode("ODS2");

function decodeBase64Url(input: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(input)) {
		throw new Error("Ungültiger Verbindungscode.");
	}
	const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function validateCredentialsTuple(parsed: unknown): Credentials {
	if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some((v) => typeof v !== "string")) {
		throw new Error("Ungültiger Verbindungscode.");
	}
	const [clientId, clientSecret, refreshToken] = parsed as string[];
	// eslint-disable-next-line no-control-regex
	const hasControl = (v: string) => /[\u0000-\u001f\u007f]/.test(v);
	if (!clientId || !refreshToken || hasControl(clientId) || hasControl(clientSecret) || hasControl(refreshToken)) {
		throw new Error("Ungültiger Verbindungscode.");
	}
	return { clientId, clientSecret, refreshToken };
}

/** Generates a uniformly distributed 6-digit numeric pairing PIN via WebCrypto CSPRNG. */
export function generatePairingPin(): string {
	const buf = new Uint32Array(1);
	const limit = 4_294_000_000;
	while (true) {
		crypto.getRandomValues(buf);
		if (buf[0] < limit) {
			return String(buf[0] % 1_000_000).padStart(6, "0");
		}
	}
}

async function deriveAesKey(pin: string, salt: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(pin),
		"PBKDF2",
		false,
		["deriveKey"]
	);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		keyMaterial,
		{ name: "AES-GCM", length: 256 },
		false,
		[usage]
	);
}

/** Returns true if the string is an encrypted ODS2 pairing code requiring a PIN. */
export function isEncryptedConnection(code: string): boolean {
	return code.trim().startsWith(CODE_PREFIX_V2);
}

/**
 * Encrypts Google credentials with AES-256-GCM using a key derived from a one-time PIN (PBKDF2-SHA256).
 * Safe to render as QR code or copy to clipboard as long as the PIN stays separate.
 */
export async function exportEncryptedConnection(
	c: Credentials,
	pin?: string
): Promise<{ code: string; pin: string }> {
	const resolvedPin = (pin ?? generatePairingPin()).trim();
	if (resolvedPin.length < 4) {
		throw new Error("Kopplungs-PIN muss mindestens 4 Zeichen lang sein.");
	}
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const key = await deriveAesKey(resolvedPin, salt, "encrypt");
	const plaintext = new TextEncoder().encode(JSON.stringify([c.clientId, c.clientSecret, c.refreshToken]));
	const cipherBuf = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: AAD_V2 },
		key,
		plaintext
	);
	const cipherBytes = new Uint8Array(cipherBuf);
	const code = `${CODE_PREFIX_V2}${base64url(salt)}.${base64url(iv)}.${base64url(cipherBytes)}`;
	return { code, pin: resolvedPin };
}

/** Decrypts and validates an ODS2 pairing code using the provided PIN. */
export async function importEncryptedConnection(code: string, pin: string): Promise<Credentials> {
	const trimmed = code.trim();
	const trimmedPin = pin.trim();
	if (!trimmed.startsWith(CODE_PREFIX_V2) || trimmed.length > 4000) {
		throw new Error("Ungültiger Verbindungscode.");
	}
	if (!trimmedPin) {
		throw new Error("Bitte Kopplungs-PIN eingeben.");
	}
	const parts = trimmed.slice(CODE_PREFIX_V2.length).split(".");
	if (parts.length !== 3) {
		throw new Error("Ungültiger Verbindungscode.");
	}
	let salt: Uint8Array;
	let iv: Uint8Array;
	let cipherBytes: Uint8Array;
	try {
		salt = decodeBase64Url(parts[0]);
		iv = decodeBase64Url(parts[1]);
		cipherBytes = decodeBase64Url(parts[2]);
	} catch {
		throw new Error("Ungültiger Verbindungscode.");
	}
	if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || cipherBytes.length < 17) {
		throw new Error("Ungültiger Verbindungscode.");
	}
	let plainBuf: ArrayBuffer;
	try {
		const key = await deriveAesKey(trimmedPin, salt, "decrypt");
		plainBuf = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD_V2 },
			key,
			cipherBytes as BufferSource
		);
	} catch {
		throw new Error("Falscher Kopplungs-PIN oder beschädigter Verbindungscode.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(plainBuf));
	} catch {
		throw new Error("Ungültiger Verbindungscode.");
	}
	return validateCredentialsTuple(parsed);
}

/** Legacy unencrypted connection code format (kept for backward compatibility on import). */
export function exportConnection(c: Credentials): string {
	return CODE_PREFIX_V1 + btoa(JSON.stringify([c.clientId, c.clientSecret, c.refreshToken]));
}

export function importConnection(code: string): Credentials {
	const trimmed = code.trim();
	if (trimmed.startsWith(CODE_PREFIX_V2)) {
		throw new Error("Für diesen verschlüsselten Verbindungscode (ODS2) ist ein Kopplungs-PIN erforderlich.");
	}
	if (!trimmed.startsWith(CODE_PREFIX_V1)) throw new Error("Ungültiger Verbindungscode.");
	if (trimmed.length > 4000) throw new Error("Ungültiger Verbindungscode.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(atob(trimmed.slice(CODE_PREFIX_V1.length)));
	} catch {
		throw new Error("Ungültiger Verbindungscode.");
	}
	return validateCredentialsTuple(parsed);
}
