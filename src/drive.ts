import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { cleanDeviceName } from "./paths";
import type { RemoteEntry } from "./plan";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,md5Checksum,modifiedTime,appProperties";
const MULTIPART_LIMIT = 4 * 1024 * 1024;

export interface Credentials {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

export class DriveError extends Error {
	constructor(message: string, public status: number) {
		super(message);
	}
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function q(value: string) {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export class DriveClient {
	private accessToken = "";
	private expiresAt = 0;

	constructor(private creds: () => Credentials) {}

	private async token(): Promise<string> {
		if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
		const c = this.creds();
		if (!c.refreshToken) throw new DriveError("Nicht mit Google Drive verbunden.", 401);
		const res = await requestUrl({
			url: TOKEN_URL,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: new URLSearchParams({
				client_id: c.clientId,
				client_secret: c.clientSecret,
				refresh_token: c.refreshToken,
				grant_type: "refresh_token",
			}).toString(),
			throw: false,
		});
		if (res.status !== 200) {
			throw new DriveError(
				`Anmeldung bei Google fehlgeschlagen (${res.status}). Bitte in den Einstellungen neu verbinden.`,
				res.status
			);
		}
		const accessToken = res.json?.access_token;
		if (typeof accessToken !== "string" || !accessToken) {
			throw new DriveError("Unerwartete Antwort von der Google-Anmeldung.", 502);
		}
		this.accessToken = accessToken;
		this.expiresAt = Date.now() + (Number(res.json.expires_in) || 3600) * 1000;
		return this.accessToken;
	}

	private async request(params: RequestUrlParam): Promise<RequestUrlResponse> {
		for (let attempt = 0; ; attempt++) {
			const token = await this.token();
			const res = await requestUrl({
				...params,
				headers: { ...(params.headers ?? {}), Authorization: `Bearer ${token}` },
				throw: false,
			});
			if (res.status < 400) return res;
			if (res.status === 401 && attempt === 0) {
				this.accessToken = "";
				continue;
			}
			const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
			if (retryable && attempt < 5) {
				await sleep(1000 * 2 ** attempt + Math.random() * 500);
				continue;
			}
			let detail = "";
			try {
				detail = res.json?.error?.message ?? "";
			} catch {
				/* ignore */
			}
			throw new DriveError(`Google Drive Fehler ${res.status}: ${detail}`, res.status);
		}
	}

	/** E-mail address of the connected Google account (to confirm the right account). */
	async accountEmail(): Promise<string> {
		const res = await this.request({ url: `${API}/about?fields=user(emailAddress)` });
		return res.json?.user?.emailAddress ?? "";
	}

	/** Finds or creates the sync folder in the root of "Meine Ablage". */
	async ensureFolder(name: string): Promise<string> {
		const query = `name='${q(name)}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`;
		const res = await this.request({
			url: `${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`,
		});
		if (res.json.files?.length) return res.json.files[0].id;
		const created = await this.request({
			url: `${API}/files?fields=id`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: ["root"] }),
		});
		return created.json.id;
	}

	async listFiles(folderId: string): Promise<RemoteEntry[]> {
		const out: RemoteEntry[] = [];
		const query = `'${q(folderId)}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`;
		let pageToken = "";
		do {
			const url =
				`${API}/files?q=${encodeURIComponent(query)}&spaces=drive&pageSize=1000` +
				`&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}` +
				(pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
			const res = await this.request({ url });
			for (const f of res.json.files ?? []) {
				out.push(toEntry(f));
			}
			pageToken = res.json.nextPageToken ?? "";
		} while (pageToken);
		return out;
	}

	async download(id: string): Promise<ArrayBuffer> {
		const res = await this.request({ url: `${API}/files/${encodeURIComponent(id)}?alt=media` });
		return res.arrayBuffer;
	}

	/** Creates (no id) or updates (id) a file. Returns the new remote state. */
	async upload(
		folderId: string,
		path: string,
		data: ArrayBuffer,
		device: string,
		id?: string,
		mtime?: number
	): Promise<RemoteEntry> {
		const metadata = buildMetadata(folderId, path, device, id, mtime);
		const fields = `fields=${encodeURIComponent(FILE_FIELDS)}`;
		const method = id ? "PATCH" : "POST";
		const base = id ? `${UPLOAD}/files/${encodeURIComponent(id)}` : `${UPLOAD}/files`;

		if (data.byteLength <= MULTIPART_LIMIT) {
			const boundary =
				"obsidian-drive-sync-" +
				Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
			const body = buildMultipart(boundary, metadata, data);
			const res = await this.request({
				url: `${base}?uploadType=multipart&${fields}`,
				method,
				contentType: `multipart/related; boundary=${boundary}`,
				body,
			});
			return toEntry(res.json);
		}

		// Resumable upload for large files.
		const init = await this.request({
			url: `${base}?uploadType=resumable&${fields}`,
			method,
			contentType: "application/json; charset=UTF-8",
			body: JSON.stringify(metadata),
		});
		const location = init.headers["location"] ?? init.headers["Location"];
		// The access token is sent to this address, so it has to be Google's.
		if (!location || !location.startsWith(UPLOAD + "/")) {
			throw new DriveError("Upload-Sitzung konnte nicht gestartet werden.", 500);
		}
		const res = await this.request({ url: location, method: "PUT", body: data });
		return toEntry(res.json);
	}

	/** Moves a file to the Google Drive trash (recoverable for 30 days). */
	async trash(id: string): Promise<void> {
		await this.request({
			url: `${API}/files/${encodeURIComponent(id)}`,
			method: "PATCH",
			contentType: "application/json",
			body: JSON.stringify({ trashed: true }),
		});
	}
}

/** Google Drive limit: key + value of each appProperty must be <= 124 bytes (UTF-8). */
export const APP_PROPERTY_LIMIT = 124;

/** Cuts a string to at most maxBytes UTF-8 bytes without breaking a character. */
export function truncateUtf8(value: string, maxBytes: number): string {
	const enc = new TextEncoder();
	if (enc.encode(value).byteLength <= maxBytes) return value;
	let out = "";
	let used = 0;
	for (const ch of value) {
		const n = enc.encode(ch).byteLength;
		if (used + n > maxBytes) break;
		out += ch;
		used += n;
	}
	return out;
}

export function buildMetadata(
	folderId: string,
	path: string,
	device: string,
	id?: string,
	mtime?: number
): Record<string, unknown> {
	const appProperties: Record<string, string | null> = {
		device: truncateUtf8(device, APP_PROPERTY_LIMIT - "device".length),
	};
	// Remove the old, size-limited path property from files of earlier versions.
	if (id) appProperties.vpath = null;
	const metadata: Record<string, unknown> = { name: path, appProperties };
	if (!id) metadata.parents = [folderId];
	// Store the real edit time (not the upload time) so "newer wins" is fair.
	if (mtime) metadata.modifiedTime = new Date(mtime).toISOString();
	return metadata;
}

function toEntry(f: {
	id: string;
	name: string;
	md5Checksum?: string;
	modifiedTime?: string;
	appProperties?: Record<string, string>;
}): RemoteEntry {
	return {
		id: f.id,
		// The file name is the vault path. (Older versions also stored it in
		// appProperties.vpath, which is limited to 124 bytes – no longer used.)
		path: f.name,
		md5: f.md5Checksum ?? "",
		modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
		device: cleanDeviceName(f.appProperties?.device),
	};
}

function buildMultipart(boundary: string, metadata: unknown, data: ArrayBuffer): ArrayBuffer {
	const enc = new TextEncoder();
	const head = enc.encode(
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
			JSON.stringify(metadata) +
			`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
	);
	const tail = enc.encode(`\r\n--${boundary}--`);
	const out = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
	out.set(head, 0);
	out.set(new Uint8Array(data), head.byteLength);
	out.set(tail, head.byteLength + data.byteLength);
	return out.buffer;
}
