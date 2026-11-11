import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveClient, DriveError } from "../src/drive";
import { backoffMs, classifyDrive, classifyToken, isSuccess, retryAfterMs } from "../src/http";
import { setRequestHandler } from "./obsidian-mock";
import { FakeDrive, buf, device } from "./fakes";

test("Drive: jeder Statuscode wird einzeln eingeordnet", () => {
  const cases: [number, string, string, boolean, string][] = [
    // status, reason, kind, retry, scope
    [0, "", "offline", false, "sync"],
    [400, "", "badRequest", false, "file"],
    [400, "invalid", "badRequest", false, "file"],
    [400, "userRateLimitExceeded", "rateLimit", true, "sync"],
    [401, "authError", "auth", false, "sync"],
    [401, "", "auth", false, "sync"],
    [403, "storageQuotaExceeded", "quota", false, "sync"],
    [403, "rateLimitExceeded", "rateLimit", true, "sync"],
    [403, "userRateLimitExceeded", "rateLimit", true, "sync"],
    [403, "dailyLimitExceeded", "rateLimit", true, "sync"],
    [403, "accessNotConfigured", "blocked", false, "sync"],
    [403, "domainPolicy", "blocked", false, "sync"],
    [403, "appNotAuthorizedToFile", "blocked", false, "file"],
    [403, "insufficientFilePermissions", "forbidden", false, "file"],
    [403, "", "forbidden", false, "file"],
    [404, "notFound", "notFound", false, "file"],
    [408, "", "timeout", true, "file"],
    [409, "", "conflict", false, "file"],
    [410, "", "notFound", false, "file"],
    [412, "conditionNotMet", "conflict", false, "file"],
    [413, "", "tooLarge", false, "file"],
    [416, "", "range", false, "file"],
    [418, "", "unexpected", false, "file"],
    [429, "rateLimitExceeded", "rateLimit", true, "sync"],
    [500, "backendError", "server", true, "sync"],
    [502, "", "server", true, "sync"],
    [503, "", "server", true, "sync"],
    [504, "", "timeout", true, "sync"],
    [507, "", "server", false, "sync"],
  ];
  for (const [status, reason, kind, retry, scope] of cases) {
    const v = classifyDrive(status, reason);
    assert.deepEqual([v.kind, v.retry, v.scope], [kind, retry, scope], `${status} ${reason}`);
    assert.ok(v.message.includes(`HTTP ${status}`), v.message);
  }
  for (const s of [200, 201, 204, 299]) assert.ok(isSuccess(s));
  for (const s of [0, 199, 300, 304, 308, 400, 500]) assert.ok(!isSuccess(s));
});

test("Anmeldung: Fehlercodes des Token-Endpunkts", () => {
  const cases: [number, string, string, boolean][] = [
    [400, "invalid_grant", "auth", false],
    [401, "invalid_client", "auth", false],
    [400, "unauthorized_client", "auth", false],
    [400, "invalid_request", "badRequest", false],
    [400, "admin_policy_enforced", "blocked", false],
    [400, "", "auth", false],
    [403, "", "blocked", false],
    [429, "", "rateLimit", true],
    [500, "", "server", true],
    [503, "temporarily_unavailable", "server", true],
    [504, "", "timeout", true],
    [0, "", "offline", false],
    [302, "", "unexpected", false],
  ];
  for (const [status, error, kind, retry] of cases) {
    const v = classifyToken(status, error);
    assert.deepEqual([v.kind, v.retry, v.scope], [kind, retry, "sync"], `${status} ${error}`);
  }
  assert.match(classifyToken(400, "invalid_grant").message, /widerrufen/);
  assert.match(classifyToken(401, "invalid_client").message, /Client-ID/);
});

test("Retry-After und Wartezeiten", () => {
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(retryAfterMs("0"), 0);
  assert.equal(retryAfterMs("600"), 60_000, "gedeckelt");
  assert.equal(retryAfterMs(undefined), null);
  assert.equal(retryAfterMs("bald"), null);
  const now = Date.parse("2026-11-11T10:00:00Z");
  assert.equal(retryAfterMs("Wed, 11 Nov 2026 10:00:05 GMT", now), 5000);
  assert.equal(retryAfterMs("Wed, 11 Nov 2026 09:00:00 GMT", now), 0);
  assert.equal(backoffMs(0, null, 0), 1000);
  assert.equal(backoffMs(3, null, 0), 8000);
  assert.equal(backoffMs(3, 2000, 0), 2000);
  assert.equal(backoffMs(0, 0, 0), 250);
});

const TOKEN = "https://oauth2.googleapis.com/token";
const creds = () => ({ clientId: "id", clientSecret: "s", refreshToken: "t" });
const gErr = (status: number, reason: string, headers = {}) =>
  ({ status, headers, json: { error: { code: status, message: "msg", errors: [{ reason }] } } });

/** Runs a client against scripted answers; returns what was requested and how long it paused. */
function client(answers: unknown[]) {
  const pauses: number[] = [], calls: string[] = [];
  let tokens = 0;
  setRequestHandler((p) => {
    if (p.url === TOKEN) { tokens++; return { status: 200, headers: {}, json: { access_token: "a" + tokens, expires_in: 3600 } }; }
    calls.push(p.headers?.Authorization ?? "");
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a ?? { status: 200, headers: {}, json: { user: { emailAddress: "ok@example.invalid" } } };
  });
  return { drive: new DriveClient(creds, async (ms) => void pauses.push(ms)), pauses, calls, tokens: () => tokens };
}
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as DriveError; } throw new Error("kein Fehler"); };

test("Anfrage: 503 und 429 werden wiederholt, Retry-After wird beachtet", async () => {
  const c = client([gErr(503, "backendError"), gErr(429, "rateLimitExceeded", { "retry-after": "7" })]);
  assert.equal(await c.drive.accountEmail(), "ok@example.invalid");
  assert.equal(c.calls.length, 3);
  assert.equal(c.pauses.length, 2);
  assert.ok(c.pauses[0] >= 1000 && c.pauses[0] < 1600);
  assert.equal(c.pauses[1], 7000);
});

test("Anfrage: dauerhafte Fehler werden nicht wiederholt", async () => {
  for (const [status, reason, kind] of [[403, "storageQuotaExceeded", "quota"], [403, "insufficientFilePermissions", "forbidden"],
    [404, "notFound", "notFound"], [400, "invalid", "badRequest"], [413, "", "tooLarge"], [412, "conditionNotMet", "conflict"]] as const) {
    const c = client([gErr(status, reason)]);
    const e = await fails(c.drive.accountEmail());
    assert.ok(e instanceof DriveError);
    assert.deepEqual([e.status, e.kind, e.reason, c.calls.length, c.pauses.length], [status, kind, reason, 1, 0]);
  }
});

test("Anfrage: nach 6 Versuchen ist Schluss", async () => {
  const c = client(Array.from({ length: 10 }, () => gErr(500, "backendError")));
  const e = await fails(c.drive.accountEmail());
  assert.deepEqual([e.kind, e.scope, c.calls.length, c.pauses.length], ["server", "sync", 6, 5]);
});

test("Anfrage: 401 holt genau einmal ein neues Zugriffstoken", async () => {
  const ok = client([gErr(401, "authError")]);
  assert.equal(await ok.drive.accountEmail(), "ok@example.invalid");
  assert.deepEqual(ok.calls, ["Bearer a1", "Bearer a2"]);
  const bad = client([gErr(401, "authError"), gErr(401, "authError"), gErr(401, "authError")]);
  const e = await fails(bad.drive.accountEmail());
  assert.deepEqual([e.kind, bad.calls.length, bad.tokens()], ["auth", 2, 2]);
});

test("Anfrage: keine Verbindung und unlesbare Fehlerantwort", async () => {
  const off = client([new Error("net::ERR_INTERNET_DISCONNECTED")]);
  const e = await fails(off.drive.accountEmail());
  assert.deepEqual([e.kind, e.status, e.offline], ["offline", 0, true]);
  const html = client([{ status: 502, headers: {}, get json() { throw new SyntaxError("kein JSON"); } }, undefined]);
  assert.equal(await html.drive.accountEmail(), "ok@example.invalid", "502 ohne JSON wird trotzdem wiederholt");
});

test("Anmeldung: widerrufener Zugang wird erkannt und nicht wiederholt", async () => {
  let n = 0;
  setRequestHandler(() => { n++; return { status: 400, headers: {}, json: { error: "invalid_grant" } }; });
  const e = await fails(new DriveClient(creds, async () => {}).accountEmail());
  assert.deepEqual([e.kind, e.reason, e.scope, n], ["auth", "invalid_grant", "sync", 1]);
  n = 0;
  setRequestHandler(() => { n++; return { status: 503, headers: {}, json: {} }; });
  const t = await fails(new DriveClient(creds, async () => {}).accountEmail());
  assert.deepEqual([t.kind, n], ["server", 3]);
});

test("Sync: Speicher voll stoppt nur die Uploads, Downloads laufen weiter", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop"), b = device(drive, "Handy");
  a.vault.set("von-a.md", buf("A"));
  await a.sync();
  for (let i = 0; i < 5; i++) b.vault.set(`neu${i}.md`, buf(`B${i}`));
  let uploads = 0;
  drive.upload = async () => { uploads++; throw new DriveError("Speicher voll", 403, "quota", "sync", "storageQuotaExceeded"); };
  const r = await b.sync();
  assert.equal(uploads, 1, "nach dem ersten Fehler kein weiterer Upload-Versuch");
  assert.equal(b.vault.text("von-a.md"), "A");
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /5 Datei\(en\) nicht hochgeladen/);
});

test("Sync: Fehler, die alles betreffen, brechen ab; Fehler einer Datei nicht", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  for (let i = 0; i < 5; i++) a.vault.set(`n${i}.md`, buf(`N${i}`));
  const real = drive.upload.bind(drive);
  let uploads = 0;
  drive.upload = async () => { uploads++; throw new DriveError("Anmeldung ungültig", 401, "auth", "sync"); };
  const e = await fails(a.sync());
  assert.deepEqual([e.kind, uploads], ["auth", 1]);
  uploads = 0;
  drive.upload = async (...args: Parameters<typeof real>) => {
    if (++uploads === 2) throw new DriveError("zu groß", 413, "tooLarge", "file");
    return real(...args);
  };
  const r = await a.sync();
  assert.deepEqual([r.uploaded, r.errors.length], [4, 1]);
});
