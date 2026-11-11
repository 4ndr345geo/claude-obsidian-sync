/**
 * Granular evaluation of HTTP answers from Google (Drive API and OAuth token
 * endpoint). Pure logic: turns status code + error reason into
 *   - a kind (what went wrong),
 *   - a decision whether repeating the request can help,
 *   - a scope (does it concern one file or the whole sync),
 *   - a message that says what the user can do.
 */

export type ErrorKind =
	| "offline" //       0   no connection at all
	| "badRequest" //    400 request not understood (bug or invalid file name)
	| "auth" //          401 / token endpoint: login no longer valid
	| "quota" //         403 storage of the Google account is full
	| "rateLimit" //     403 / 429 too many requests
	| "forbidden" //     403 no permission for this file or folder
	| "blocked" //       403 Drive API switched off / blocked by an administrator
	| "notFound" //      404 / 410 file no longer exists
	| "timeout" //       408 / 504
	| "conflict" //      409 / 412 file was changed at the same moment
	| "tooLarge" //      413 file too large
	| "range" //         416 interrupted upload cannot be continued
	| "server" //        5xx Google has a problem
	| "unexpected"; //   anything else, or an answer that cannot be read

/** file = only this file failed, go on with the others; sync = stop the whole run */
export type ErrorScope = "file" | "sync";

export interface HttpVerdict {
	kind: ErrorKind;
	/** Repeating the same request after a pause can succeed. */
	retry: boolean;
	scope: ErrorScope;
	message: string;
}

const RATE_REASONS = new Set([
	"rateLimitExceeded",
	"userRateLimitExceeded",
	"sharingRateLimitExceeded",
	"dailyLimitExceeded",
	"quotaExceeded",
]);
const STORAGE_REASONS = new Set(["storageQuotaExceeded", "teamDriveFileLimitExceeded", "fileLimitExceeded"]);
const BLOCKED_REASONS = new Set([
	"accessNotConfigured",
	"domainPolicy",
	"dailyLimitExceededUnreg",
	"appNotAuthorizedToFile",
	"cannotDownloadAbusiveFile",
	"abuse",
]);
const AUTH_REASONS = new Set(["authError", "required", "invalidCredentials", "expired"]);

export function isSuccess(status: number): boolean {
	return status >= 200 && status < 300;
}

/**
 * Drive API answers.
 * @param status  HTTP status code
 * @param reason  `error.errors[0].reason` of the answer ("" if unknown)
 * @param detail  `error.message` of the answer (shown for rare cases)
 */
export function classifyDrive(status: number, reason = "", detail = ""): HttpVerdict {
	const v = (kind: ErrorKind, retry: boolean, scope: ErrorScope, text: string): HttpVerdict => ({
		kind,
		retry,
		scope,
		message: `${text} (HTTP ${status}${reason ? `, ${reason}` : ""})`,
	});
	const extra = detail ? `: ${detail}` : "";

	if (status === 0) return v("offline", false, "sync", "Keine Verbindung zu Google");

	if (status === 400) {
		// Google reports some limits with 400 instead of 403.
		if (RATE_REASONS.has(reason)) return v("rateLimit", true, "sync", "Zu viele Anfragen an Google Drive");
		return v("badRequest", false, "file", `Google Drive hat die Anfrage abgelehnt${extra}`);
	}
	if (status === 401 || AUTH_REASONS.has(reason)) {
		return v("auth", false, "sync", "Die Anmeldung bei Google ist nicht mehr gültig. Bitte in den Einstellungen neu verbinden");
	}
	if (status === 403) {
		if (STORAGE_REASONS.has(reason)) {
			return v("quota", false, "sync", "Der Speicherplatz in Google Drive ist voll. Es kann nichts mehr hochgeladen werden");
		}
		if (RATE_REASONS.has(reason)) return v("rateLimit", true, "sync", "Zu viele Anfragen an Google Drive");
		if (BLOCKED_REASONS.has(reason)) {
			return v(
				"blocked",
				false,
				reason === "appNotAuthorizedToFile" || reason === "cannotDownloadAbusiveFile" ? "file" : "sync",
				reason === "accessNotConfigured"
					? "Die Google Drive API ist im Google-Cloud-Projekt nicht aktiviert"
					: `Google Drive verweigert den Zugriff${extra}`
			);
		}
		return v("forbidden", false, "file", `Keine Berechtigung für diese Datei${extra}`);
	}
	if (status === 404 || status === 410) {
		return v("notFound", false, "file", "Die Datei gibt es in Google Drive nicht mehr");
	}
	if (status === 408) return v("timeout", true, "file", "Zeitüberschreitung bei Google Drive");
	if (status === 409 || status === 412) {
		return v("conflict", false, "file", "Die Datei wurde gleichzeitig geändert. Sie wird beim nächsten Mal erneut geprüft");
	}
	if (status === 413) return v("tooLarge", false, "file", "Die Datei ist für Google Drive zu groß");
	if (status === 416) return v("range", false, "file", "Der Upload wurde unterbrochen und wird beim nächsten Mal neu gestartet");
	if (status === 429) return v("rateLimit", true, "sync", "Zu viele Anfragen an Google Drive");
	if (status === 504) return v("timeout", true, "sync", "Zeitüberschreitung bei Google Drive");
	if (status === 500 || status === 502 || status === 503) {
		return v("server", true, "sync", "Google Drive ist gerade gestört. Es wird später erneut versucht");
	}
	if (status >= 500) return v("server", false, "sync", `Google Drive meldet einen Fehler${extra}`);
	return v("unexpected", false, "file", `Unerwartete Antwort von Google Drive${extra}`);
}

/**
 * OAuth token endpoint (RFC 6749 section 5.2).
 * @param error  the `error` field of the answer, e.g. "invalid_grant"
 */
export function classifyToken(status: number, error = ""): HttpVerdict {
	const v = (kind: ErrorKind, retry: boolean, text: string): HttpVerdict => ({
		kind,
		retry,
		scope: "sync",
		message: `${text} (HTTP ${status}${error ? `, ${error}` : ""})`,
	});
	if (status === 0) return v("offline", false, "Keine Verbindung zu Google");
	if (error === "invalid_grant") {
		return v("auth", false, "Der Zugang wurde widerrufen oder ist abgelaufen. Bitte in den Einstellungen neu verbinden");
	}
	if (error === "invalid_client" || error === "unauthorized_client" || error === "deleted_client") {
		return v("auth", false, "Client-ID oder Client-Secret sind ungültig. Bitte in den Einstellungen prüfen und neu verbinden");
	}
	if (error === "admin_policy_enforced" || error === "access_denied" || error === "org_internal") {
		return v("blocked", false, "Das Google-Konto oder dessen Administrator verweigert den Zugriff");
	}
	if (error === "invalid_scope" || error === "invalid_request" || error === "unsupported_grant_type") {
		return v("badRequest", false, "Die Google-Anmeldung hat die Anfrage abgelehnt");
	}
	if (status === 400 || status === 401) {
		return v("auth", false, "Anmeldung bei Google fehlgeschlagen. Bitte in den Einstellungen neu verbinden");
	}
	if (status === 403) return v("blocked", false, "Die Google-Anmeldung verweigert den Zugriff");
	if (status === 429 || error === "slow_down" || error === "rate_limit_exceeded") {
		return v("rateLimit", true, "Zu viele Anmeldeversuche bei Google");
	}
	if (status === 408 || status === 504) return v("timeout", true, "Zeitüberschreitung bei der Google-Anmeldung");
	if (status === 500 || status === 502 || status === 503 || error === "temporarily_unavailable" || error === "server_error") {
		return v("server", true, "Die Google-Anmeldung ist gerade gestört. Es wird später erneut versucht");
	}
	return v("unexpected", false, "Unerwartete Antwort von der Google-Anmeldung");
}

/**
 * `Retry-After` header: seconds or an HTTP date. Returns milliseconds,
 * limited so that a sync never waits for minutes.
 */
export function retryAfterMs(header: string | undefined, now = Date.now(), maxMs = 60_000): number | null {
	if (!header) return null;
	const trimmed = header.trim();
	let ms: number;
	if (/^\d+(\.\d+)?$/.test(trimmed)) ms = Number(trimmed) * 1000;
	else {
		const date = Date.parse(trimmed);
		if (Number.isNaN(date)) return null;
		ms = date - now;
	}
	return Math.min(Math.max(ms, 0), maxMs);
}

export const MAX_ATTEMPTS = 6;

/** Pause before attempt number `attempt + 1` (exponential, with jitter; the server's wish wins). */
export function backoffMs(attempt: number, retryAfter: number | null, random = Math.random()): number {
	const own = 1000 * 2 ** attempt + random * 500;
	return retryAfter !== null ? Math.max(retryAfter, 250) : own;
}
