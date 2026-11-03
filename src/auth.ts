import { Platform, requestUrl } from "obsidian";
import type { Credentials } from "./drive";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Only files created by this plugin are visible to it – the rest of your Drive stays private. */
export const SCOPE = "https://www.googleapis.com/auth/drive.file";

function base64url(bytes: Uint8Array): string {
	let s = "";
	bytes.forEach((b) => (s += String.fromCharCode(b)));
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Desktop OAuth flow: opens the browser, receives the code on a temporary
 * local web server (127.0.0.1) and exchanges it for a refresh token.
 */
export async function authorizeDesktop(clientId: string, clientSecret: string): Promise<string> {
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
				const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
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
					scope: SCOPE,
					access_type: "offline",
					prompt: "consent",
					code_challenge: challenge,
					code_challenge_method: "S256",
					state,
				});
				window.open(`${AUTH_URL}?${params.toString()}`);
			});
			server.on("error", reject);
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

const CODE_PREFIX = "ODS1:";

/** Connection code to transfer the login to phones/tablets. Contains secrets! */
export function exportConnection(c: Credentials): string {
	return CODE_PREFIX + btoa(JSON.stringify([c.clientId, c.clientSecret, c.refreshToken]));
}

export function importConnection(code: string): Credentials {
	const trimmed = code.trim();
	if (!trimmed.startsWith(CODE_PREFIX)) throw new Error("Ungültiger Verbindungscode.");
	const [clientId, clientSecret, refreshToken] = JSON.parse(atob(trimmed.slice(CODE_PREFIX.length)));
	if (!clientId || !refreshToken) throw new Error("Ungültiger Verbindungscode.");
	return { clientId, clientSecret, refreshToken };
}
