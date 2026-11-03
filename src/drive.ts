import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
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
		this.accessToken = res.json.access_token;
		this.expiresAt = Date.now() + res.json.expires_in * 1000;
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
		const query = `'${folderId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`;
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
		const res = await this.request({ url: `${API}/files/${id}?alt=media` });
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
		const metadata: Record<string, unknown> = {
			name: path,
			appProperties: { vpath: path, device },
		};
		// Store the real edit time (not the upload time) so "newer wins" is fair.
		if (mtime) metadata.modifiedTime = new Date(mtime).toISOString();
		if (!id) metadata.parents = [folderId];
		const fields = `fields=${encodeURIComponent(FILE_FIELDS)}`;
		const method = id ? "PATCH" : "POST";
		const base = id ? `${UPLOAD}/files/${id}` : `${UPLOAD}/files`;

		if (data.byteLength <= MULTIPART_LIMIT) {
			const boundary = "obsidian-drive-sync-" + Math.random().toString(36).slice(2);
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
		if (!location) throw new DriveError("Upload-Sitzung konnte nicht gestartet werden.", 500);
		const res = await this.request({ url: location, method: "PUT", body: data });
		return toEntry(res.json);
	}

	/** Moves a file to the Google Drive trash (recoverable for 30 days). */
	async trash(id: string): Promise<void> {
		await this.request({
			url: `${API}/files/${id}`,
			method: "PATCH",
			contentType: "application/json",
			body: JSON.stringify({ trashed: true }),
		});
	}
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
		path: f.appProperties?.vpath ?? f.name,
		md5: f.md5Checksum ?? "",
		modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
		device: f.appProperties?.device,
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
