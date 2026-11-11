import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import SparkMD5 from "spark-md5";
import { backoffMs, classifyDrive, classifyToken, ErrorKind, ErrorScope, HttpVerdict, isSuccess, MAX_ATTEMPTS, retryAfterMs } from "./http";
import { cleanDeviceName } from "./paths";
import type { RemoteEntry } from "./plan";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,md5Checksum,modifiedTime,appProperties,size";
const MULTIPART_LIMIT = 4 * 1024 * 1024;

export interface Credentials {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

export class DriveError extends Error {
	/**
	 * @param status HTTP status; 0 = Google could not be reached at all (offline)
	 * @param kind   what went wrong (see http.ts)
	 * @param scope  "file": only this file failed; "sync": the whole run has to stop
	 * @param reason Google's own reason code, e.g. "storageQuotaExceeded" or "invalid_grant"
	 */
	constructor(
		message: string,
		public status: number,
		public kind: ErrorKind = status === 0 ? "offline" : "unexpected",
		public scope: ErrorScope = "sync",
		public reason = ""
	) {
		super(message);
	}
	get offline(): boolean {
		return this.kind === "offline";
	}
	/** The network failed (no connection or no answer in time) – not Google, not the file. */
	get network(): boolean {
		return this.status === 0;
	}
	static from(v: HttpVerdict, status: number, reason: string): DriveError {
		return new DriveError(v.message, status, v.kind, v.scope, reason);
	}
}

/** What the browser/app knows about the connection; "unknown" counts as online. */
function browserOnline(): boolean {
	return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Pauses before repeating a request after a network error (a short dropout, e.g. Wi-Fi to mobile). */
const NET_BACKOFF = [1500, 4000];

/** The body of an error or a broken response is not always JSON. */
function safeJson(res: RequestUrlResponse): any {
	try {
		return res.json ?? {};
	} catch {
		return {};
	}
}

function header(res: RequestUrlResponse, name: string): string | undefined {
	const h = res.headers ?? {};
	return h[name] ?? h[name.toLowerCase()];
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Value inside a Drive search query ('...'). Control characters are removed,
 * backslash and single quote are escaped – the value cannot end the string
 * and add its own conditions.
 */
export function q(value: string) {
	// eslint-disable-next-line no-control-regex
	return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Google file ids: letters, digits, "-" and "_" only. Anything else is rejected. */
const ID = /^[A-Za-z0-9_-]{1,200}$/;
export function checkId(id: unknown): string {
	if (typeof id !== "string" || !ID.test(id)) throw new DriveError("Ungültige Datei-ID von Google Drive.", 502, "unexpected", "file");
	return id;
}

/** The only hosts that ever receive a request (and with it the access token). */
const ALLOWED_HOSTS = new Set(["www.googleapis.com", "oauth2.googleapis.com"]);
// eslint-disable-next-line no-control-regex
const UNSAFE_HEADER = /[\r\n\u0000]/;

/**
 * Last check before anything leaves the device: HTTPS to Google only, and no
 * line breaks in the address or in header values (HTTP header splitting).
 */
export function checkOutgoing(params: RequestUrlParam): void {
	let url: URL;
	try {
		url = new URL(params.url);
	} catch {
		throw new DriveError("Ungültige Adresse.", 0, "badRequest", "file");
	}
	// eslint-disable-next-line no-control-regex
	if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || /[\s\u0000-\u001f]/.test(params.url)) {
		throw new DriveError(`Anfrage an ${url.hostname || "?"} blockiert: nur Google ist erlaubt.`, 0, "badRequest", "file");
	}
	const values = [params.contentType ?? "", params.method ?? "", ...Object.keys(params.headers ?? {}), ...Object.values(params.headers ?? {})];
	if (values.some((v) => UNSAFE_HEADER.test(String(v)))) {
		throw new DriveError("Anfrage blockiert: Zeilenumbruch in einem HTTP-Header.", 0, "badRequest", "file");
	}
}

export class DriveClient {
	private accessToken = "";
	private expiresAt = 0;

	/**
	 * Time limits. A request without an answer would otherwise block the sync
	 * for good (e.g. on a train, or when the phone app was in the background).
	 */
	timeouts = {
		/** listing, metadata, login */
		meta: 30_000,
		/** transfers: base time plus time for the data at the slowest speed assumed */
		transferBase: 60_000,
		bytesPerSecond: 50_000,
		max: 15 * 60_000,
	};
	/** Large files are sent in pieces of this size (multiple of 256 KiB, required by Google). */
	chunkSize = 8 * 1024 * 1024;
	/** A 308 answer has been seen: piecewise uploads work on this device. */
	private chunkedVerified = false;
	/** Fallback active: piecewise uploads did not work here, large files go in one piece. */
	chunkedUnsupported = false;
	/** Interrupted large uploads, so the next attempt continues instead of starting over. Memory only. */
	private sessions = new Map<string, { url: string; created: number }>();

	/**
	 * @param pause  waiting between attempts (replaceable for tests)
	 * @param online whether the device has a connection at all (replaceable for tests)
	 */
	constructor(
		private creds: () => Credentials,
		private pause: (ms: number) => Promise<unknown> = sleep,
		private online: () => boolean = browserOnline
	) {}

	transferTimeout(bytes: number | undefined): number {
		if (bytes === undefined || !Number.isFinite(bytes)) return this.timeouts.max;
		return Math.min(this.timeouts.max, this.timeouts.transferBase + (bytes / this.timeouts.bytesPerSecond) * 1000);
	}

	/**
	 * One HTTP request with a time limit. Network problems become a DriveError
	 * with status 0: kind "offline" (no connection) or "timeout" (no answer).
	 */
	private async send(params: RequestUrlParam, timeoutMs: number, scope: ErrorScope): Promise<RequestUrlResponse> {
		checkOutgoing(params);
		if (!this.online()) throw new DriveError("Keine Verbindung zu Google (Gerät ist offline).", 0, "offline");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new DriveError(
							`Zeitüberschreitung: Google hat nicht innerhalb von ${Math.round(timeoutMs / 1000)} s geantwortet.`,
							0,
							"timeout",
							scope
						)
					),
				timeoutMs
			);
		});
		try {
			return await Promise.race([
				requestUrl({ ...params, throw: false }).catch((e: unknown) => {
					throw new DriveError(`Keine Verbindung zu Google (${(e as Error)?.message ?? e}).`, 0, "offline");
				}),
				timeout,
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Like send(), but a short network dropout is bridged by repeating the
	 * request a few times – unless the device is known to be offline.
	 */
	private async sendRetrying(params: RequestUrlParam, timeoutMs: number, scope: ErrorScope): Promise<RequestUrlResponse> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.send(params, timeoutMs, scope);
			} catch (e) {
				if (e instanceof DriveError && e.network && attempt < NET_BACKOFF.length && this.online()) {
					await this.pause(NET_BACKOFF[attempt]);
					continue;
				}
				throw e;
			}
		}
	}

	private async token(): Promise<string> {
		if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
		const c = this.creds();
		if (!c.refreshToken) throw new DriveError("Nicht mit Google Drive verbunden.", 401, "auth");
		let res: RequestUrlResponse;
		for (let attempt = 0; ; attempt++) {
			res = await this.sendRetrying({
				url: TOKEN_URL,
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				body: new URLSearchParams({
					client_id: c.clientId,
					client_secret: c.clientSecret,
					refresh_token: c.refreshToken,
					grant_type: "refresh_token",
				}).toString(),
			}, this.timeouts.meta, "sync");
			if (isSuccess(res.status)) break;
			const error = String(safeJson(res).error ?? "");
			const verdict = classifyToken(res.status, error);
			// Few attempts only: the token endpoint must not be hammered.
			if (verdict.retry && attempt < 2) {
				await this.pause(backoffMs(attempt, retryAfterMs(header(res, "Retry-After"))));
				continue;
			}
			throw DriveError.from(verdict, res.status, error);
		}
		const json = safeJson(res);
		const accessToken = json.access_token;
		// The token goes into a header: printable ASCII only, so it cannot split the header.
		if (typeof accessToken !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(accessToken)) {
			throw new DriveError("Unerwartete Antwort von der Google-Anmeldung.", res.status, "unexpected");
		}
		this.accessToken = accessToken;
		this.expiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
		return this.accessToken;
	}

	/**
	 * @param transfer for up-/downloads: time limit by size; running out of time
	 *                 then concerns only this file (scope "file").
	 */
	private async request(params: RequestUrlParam, transfer?: { bytes: number | undefined }): Promise<RequestUrlResponse> {
		let refreshed = false;
		const timeoutMs = transfer ? this.transferTimeout(transfer.bytes) : this.timeouts.meta;
		for (let attempt = 0; ; attempt++) {
			const token = await this.token();
			const res = await this.sendRetrying(
				{ ...params, headers: { ...(params.headers ?? {}), Authorization: `Bearer ${token}` } },
				timeoutMs,
				transfer ? "file" : "sync"
			);
			if (isSuccess(res.status)) return res;
			const error = safeJson(res).error ?? {};
			const reason = String(error.errors?.[0]?.reason ?? "");
			const detail = typeof error.message === "string" ? error.message.slice(0, 300) : "";
			const verdict = classifyDrive(res.status, reason, detail);
			// 401: the access token may simply have expired early – get a new one, once.
			if (verdict.kind === "auth" && !refreshed) {
				refreshed = true;
				this.accessToken = "";
				continue;
			}
			if (verdict.retry && attempt < MAX_ATTEMPTS - 1) {
				await this.pause(backoffMs(attempt, retryAfterMs(header(res, "Retry-After"))));
				continue;
			}
			throw DriveError.from(verdict, res.status, reason);
		}
	}

	/** E-mail address of the connected Google account (to confirm the right account). */
	async accountEmail(): Promise<string> {
		const res = await this.request({ url: `${API}/about?fields=user(emailAddress)` });
		return safeJson(res).user?.emailAddress ?? "";
	}

	/** Finds or creates the sync folder in the root of "Meine Ablage". */
	async ensureFolder(name: string): Promise<string> {
		const query = `name='${q(name)}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`;
		const res = await this.request({
			url: `${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`,
		});
		const found = safeJson(res).files;
		if (Array.isArray(found) && found.length) return checkId(found[0].id);
		const created = await this.request({
			url: `${API}/files?fields=id`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: ["root"] }),
		});
		return checkId(safeJson(created).id);
	}

	/**
	 * Is the remembered sync folder still there? A folder that was deleted or
	 * moved to the trash lists no files – that must not look like "all files
	 * were deleted on another device".
	 */
	async folderUsable(folderId: string): Promise<boolean> {
		try {
			const res = await this.request({
				url: `${API}/files/${encodeURIComponent(folderId)}?fields=id,trashed,mimeType`,
			});
			const f = safeJson(res);
			return f.id === folderId && f.trashed === false && f.mimeType === FOLDER_MIME;
		} catch (e) {
			if (e instanceof DriveError && e.kind === "notFound") return false;
			throw e;
		}
	}

	/** Current state of one file (for the check right before an upload or deletion). */
	async getMeta(id: string): Promise<RemoteEntry | null> {
		try {
			const res = await this.request({
				url: `${API}/files/${encodeURIComponent(checkId(id))}?fields=${encodeURIComponent(FILE_FIELDS + ",trashed")}`,
			});
			const f = safeJson(res);
			return f.trashed ? null : toEntry(f);
		} catch (e) {
			if (e instanceof DriveError && e.kind === "notFound") return null;
			throw e;
		}
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
			// A list that cannot be read must stop the sync: an incomplete list
			// would look as if the missing files had been deleted.
			let page: any;
			try {
				page = res.json;
			} catch {
				page = null;
			}
			if (!page || !Array.isArray(page.files)) {
				throw new DriveError("Unerwartete Antwort von Google Drive (Dateiliste).", res.status, "unexpected");
			}
			for (const f of page.files) out.push(toEntry(f));
			pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
		} while (pageToken);
		return out;
	}

	/** @param size expected size in bytes (sets the time limit) */
	async download(id: string, size?: number): Promise<ArrayBuffer> {
		const res = await this.request({ url: `${API}/files/${encodeURIComponent(id)}?alt=media` }, { bytes: size });
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
			const res = await this.request(
				{
					url: `${base}?uploadType=multipart&${fields}`,
					method,
					contentType: `multipart/related; boundary=${boundary}`,
					body,
				},
				{ bytes: body.byteLength }
			);
			return toEntry(safeJson(res));
		}

		if (this.chunkedUnsupported) return this.uploadWhole(base, method, fields, metadata, data);
		try {
			return await this.uploadChunked(base, method, fields, metadata, data, folderId, path, id);
		} catch (e) {
			// Fallback: if piecewise uploading never worked on this device (e.g. the
			// app does not pass Google's "308" answer through), send the file in one
			// piece as earlier versions did, and keep doing so.
			const suspicious = e instanceof DriveError && (e.network || e.kind === "unexpected");
			if (this.chunkedVerified || !suspicious || !this.online()) throw e;
			const entry = await this.uploadWhole(base, method, fields, metadata, data);
			this.chunkedUnsupported = true;
			console.warn("[Google Drive Sync] Upload in Teilen funktioniert hier nicht, große Dateien werden am Stück gesendet.", e);
			return entry;
		}
	}

	/** Resumable upload in one request (no resuming after a dropout). */
	private async uploadWhole(
		base: string,
		method: string,
		fields: string,
		metadata: Record<string, unknown>,
		data: ArrayBuffer
	): Promise<RemoteEntry> {
		const location = await this.startSession(base, method, fields, metadata);
		const res = await this.request({ url: location, method: "PUT", body: data }, { bytes: data.byteLength });
		return toEntry(safeJson(res));
	}

	private async startSession(base: string, method: string, fields: string, metadata: Record<string, unknown>): Promise<string> {
		const init = await this.request({
			url: `${base}?uploadType=resumable&${fields}`,
			method,
			contentType: "application/json; charset=UTF-8",
			body: JSON.stringify(metadata),
		});
		const location = header(init, "Location");
		// The access token is sent to this address, so it has to be Google's.
		if (!location || !location.startsWith(UPLOAD + "/")) {
			throw new DriveError("Upload-Sitzung konnte nicht gestartet werden.", init.status, "unexpected", "file");
		}
		return location;
	}

	/**
	 * Large files: resumable upload in pieces. After a dropout the upload
	 * continues where Google stopped receiving, instead of starting over.
	 */
	private async uploadChunked(
		base: string,
		method: string,
		fields: string,
		metadata: Record<string, unknown>,
		data: ArrayBuffer,
		folderId: string,
		path: string,
		id?: string
	): Promise<RemoteEntry> {
		const key = `${id ?? folderId}|${path}|${data.byteLength}|${SparkMD5.ArrayBuffer.hash(data)}`;
		let restarted = false;
		for (;;) {
			let session = this.sessions.get(key);
			if (session && Date.now() - session.created > 24 * 3600_000) session = undefined;
			let offset = 0;
			if (session) {
				const state = await this.uploadStatus(session.url, data.byteLength);
				if (state === "expired") session = undefined;
				else if (typeof state === "number") offset = state;
				else {
					this.sessions.delete(key);
					return state;
				}
			}
			if (!session) {
				session = { url: await this.startSession(base, method, fields, metadata), created: Date.now() };
				this.sessions.set(key, session);
			}
			const result = await this.sendChunks(session.url, data, offset);
			if (result === "expired") {
				this.sessions.delete(key);
				if (restarted) throw new DriveError("Upload-Sitzung abgelaufen.", 404, "notFound", "file");
				restarted = true;
				continue;
			}
			this.sessions.delete(key);
			return result;
		}
	}

	/** Sends the file from `offset` on, piece by piece; repeats a piece after a dropout. */
	private async sendChunks(url: string, data: ArrayBuffer, offset: number): Promise<RemoteEntry | "expired"> {
		const total = data.byteLength;
		let failures = 0;
		while (offset < total) {
			const end = Math.min(offset + this.chunkSize, total);
			let res: RequestUrlResponse;
			try {
				res = await this.send(
					{
						url,
						method: "PUT",
						headers: {
							Authorization: `Bearer ${await this.token()}`,
							"Content-Range": `bytes ${offset}-${end - 1}/${total}`,
						},
						body: data.slice(offset, end),
					},
					this.transferTimeout(end - offset),
					"file"
				);
			} catch (e) {
				// Part of the piece may have arrived: ask Google where to go on.
				if (e instanceof DriveError && e.network && failures < 3 && this.online()) {
					failures++;
					await this.pause(NET_BACKOFF[Math.min(failures - 1, NET_BACKOFF.length - 1)]);
					const state = await this.uploadStatus(url, total);
					if (typeof state !== "number") return state;
					offset = state;
					continue;
				}
				throw e;
			}
			if (res.status === 308) {
				this.chunkedVerified = true;
				offset = receivedUntil(res) ?? end;
				failures = 0;
				continue;
			}
			if (isSuccess(res.status)) return toEntry(safeJson(res));
			if (res.status === 404 || res.status === 410) return "expired";
			const error = safeJson(res).error ?? {};
			const reason = String(error.errors?.[0]?.reason ?? "");
			const verdict = classifyDrive(res.status, reason, typeof error.message === "string" ? error.message.slice(0, 300) : "");
			if (verdict.retry && failures < 3) {
				failures++;
				await this.pause(backoffMs(failures - 1, retryAfterMs(header(res, "Retry-After"))));
				const state = await this.uploadStatus(url, total);
				if (typeof state !== "number") return state;
				offset = state;
				continue;
			}
			throw DriveError.from(verdict, res.status, reason);
		}
		// Everything was sent, but the last answer was lost: ask for the result.
		const state = await this.uploadStatus(url, total);
		if (typeof state === "number") throw new DriveError("Upload unvollständig.", 308, "unexpected", "file");
		return state;
	}

	/**
	 * Asks Google how much of an interrupted upload has arrived.
	 * @returns the next byte to send, the finished file, or "expired"
	 */
	private async uploadStatus(url: string, total: number): Promise<number | RemoteEntry | "expired"> {
		const res = await this.sendRetrying(
			{
				url,
				method: "PUT",
				headers: { Authorization: `Bearer ${await this.token()}`, "Content-Range": `bytes */${total}` },
				body: new ArrayBuffer(0),
			},
			this.timeouts.meta,
			"file"
		);
		if (res.status === 308) {
			this.chunkedVerified = true;
			return receivedUntil(res) ?? 0;
		}
		if (isSuccess(res.status)) return toEntry(safeJson(res));
		if (res.status === 404 || res.status === 410) return "expired";
		const error = safeJson(res).error ?? {};
		const reason = String(error.errors?.[0]?.reason ?? "");
		throw DriveError.from(classifyDrive(res.status, reason), res.status, reason);
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

/** "Range: bytes=0-524287" of a 308 answer -> 524288 (next byte to send). */
function receivedUntil(res: RequestUrlResponse): number | null {
	const m = /^bytes=0-(\d+)$/.exec((header(res, "Range") ?? "").trim());
	return m ? Number(m[1]) + 1 : null;
}

function toEntry(f: {
	id: string;
	name: string;
	md5Checksum?: string;
	modifiedTime?: string;
	appProperties?: Record<string, string>;
	size?: string;
}): RemoteEntry {
	if (!f || typeof f.name !== "string") {
		throw new DriveError("Unerwartete Antwort von Google Drive (Datei).", 502, "unexpected", "file");
	}
	checkId(f.id);
	return {
		id: f.id,
		// The file name is the vault path. (Older versions also stored it in
		// appProperties.vpath, which is limited to 124 bytes – no longer used.)
		path: f.name,
		md5: typeof f.md5Checksum === "string" ? f.md5Checksum : "",
		modifiedTime: (f.modifiedTime && Date.parse(f.modifiedTime)) || 0,
		device: cleanDeviceName(f.appProperties?.device),
		size: f.size !== undefined && /^\d+$/.test(String(f.size)) ? Number(f.size) : undefined,
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
