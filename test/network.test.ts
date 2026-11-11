import { test } from "node:test";
import assert from "node:assert/strict";
import SparkMD5 from "spark-md5";
import { DriveClient, DriveError } from "../src/drive";
import { setRequestHandler } from "./obsidian-mock";
import { FakeDrive, buf, device } from "./fakes";

const TOKEN = "https://oauth2.googleapis.com/token";
const creds = () => ({ clientId: "id", clientSecret: "s", refreshToken: "t" });
const tokenAnswer = { status: 200, headers: {}, json: { access_token: "a", expires_in: 3600 } };
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as DriveError; } throw new Error("kein Fehler"); };
const never = () => new Promise(() => {});

test("Zeitlimit: eine hängende Anfrage blockiert nicht für immer", async () => {
  let calls = 0;
  setRequestHandler((p) => (p.url === TOKEN ? tokenAnswer : (calls++, never())));
  const drive = new DriveClient(creds, async () => {});
  drive.timeouts.meta = 20;
  const e = await fails(drive.accountEmail());
  assert.deepEqual([e.kind, e.status, e.scope, e.network], ["timeout", 0, "sync", true]);
  assert.equal(calls, 3, "kurzer Aussetzer wird zweimal überbrückt");
  assert.match(e.message, /Zeitüberschreitung/);
});

test("Zeitlimit für Übertragungen wächst mit der Dateigröße und betrifft nur die Datei", async () => {
  const drive = new DriveClient(creds, async () => {});
  assert.equal(drive.transferTimeout(0), 60_000);
  assert.equal(drive.transferTimeout(5_000_000), 160_000);
  assert.equal(drive.transferTimeout(10_000_000_000), 15 * 60_000);
  assert.equal(drive.transferTimeout(undefined), 15 * 60_000);
  setRequestHandler((p) => (p.url === TOKEN ? tokenAnswer : never()));
  drive.timeouts.transferBase = 20;
  const e = await fails(drive.download("id1", 0));
  assert.deepEqual([e.kind, e.scope], ["timeout", "file"]);
});

test("Gerät offline: keine Anfrage, sofortiger Abbruch ohne Wartezeit", async () => {
  let calls = 0;
  const pauses: number[] = [];
  setRequestHandler(() => { calls++; return tokenAnswer; });
  const e = await fails(new DriveClient(creds, async (ms) => void pauses.push(ms), () => false).accountEmail());
  assert.deepEqual([e.kind, calls, pauses.length], ["offline", 0, 0]);
  assert.match(e.message, /Gerät ist offline/);
});

test("Kurzer Aussetzer wird überbrückt", async () => {
  let n = 0;
  setRequestHandler((p) => {
    if (p.url === TOKEN) return tokenAnswer;
    if (++n === 1) throw new Error("net::ERR_NETWORK_CHANGED");
    return { status: 200, headers: {}, json: { user: { emailAddress: "ok@example.invalid" } } };
  });
  assert.equal(await new DriveClient(creds, async () => {}).accountEmail(), "ok@example.invalid");
});

/** Minimal Google resumable-upload server. */
function uploadServer(opts: { dropAt?: number[]; acceptPartial?: number } = {}) {
  let received = new Uint8Array(0);
  let total = 0, sessions = 0, chunkCalls = 0, statusCalls = 0;
  const sent: number[] = [];
  const drops = [...(opts.dropAt ?? [])];
  setRequestHandler(((p: { url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer }) => {
    if (p.url === TOKEN) return tokenAnswer;
    if (p.url.includes("uploadType=resumable")) {
      sessions++;
      received = new Uint8Array(0);
      return { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=s${sessions}` }, json: {} };
    }
    const range = p.headers?.["Content-Range"] ?? "";
    const done = () => ({ status: 200, headers: {}, json: { id: "f1", name: "gross.bin", md5Checksum: SparkMD5.ArrayBuffer.hash(received.buffer as ArrayBuffer), size: String(received.length) } });
    const incomplete = () => ({ status: 308, headers: received.length ? { range: `bytes=0-${received.length - 1}` } : {}, json: {} });
    if (range.startsWith("bytes */")) {
      statusCalls++;
      return received.length === total && total > 0 ? done() : incomplete();
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)!;
    const [start, , all] = [Number(m[1]), Number(m[2]), Number(m[3])];
    total = all;
    chunkCalls++;
    const body = new Uint8Array(p.body!);
    sent.push(body.length);
    assert.equal(start, received.length, "lückenlos fortgesetzt");
    if (drops.length && chunkCalls === drops[0]) {
      drops.shift();
      // the connection breaks after half of the piece has arrived
      const half = body.slice(0, Math.floor(body.length / 2));
      const merged = new Uint8Array(received.length + half.length); merged.set(received); merged.set(half, received.length);
      received = merged;
      throw new Error("net::ERR_CONNECTION_RESET");
    }
    const merged = new Uint8Array(received.length + body.length); merged.set(received); merged.set(body, received.length);
    received = merged;
    return received.length === total ? done() : incomplete();
  }) as never);
  return { get received() { return received; }, get sessions() { return sessions; }, sent, get statusCalls() { return statusCalls; } };
}

const bigData = (n: number) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 31) % 251; return a.buffer as ArrayBuffer; };

test("Großer Upload wird in Teilen gesendet", async () => {
  const srv = uploadServer();
  const drive = new DriveClient(creds, async () => {});
  drive.chunkSize = 1 << 20;
  const data = bigData(5 * (1 << 20) + 123);
  const entry = await drive.upload("folder", "gross.bin", data, "Laptop");
  assert.equal(entry.md5, SparkMD5.ArrayBuffer.hash(data));
  assert.equal(entry.size, data.byteLength);
  assert.equal(srv.sent.length, 6);
  assert.equal(srv.sessions, 1);
});

test("Abbruch mitten im Upload: es geht dort weiter, wo Google aufgehört hat", async () => {
  const srv = uploadServer({ dropAt: [3] });
  const drive = new DriveClient(creds, async () => {});
  drive.chunkSize = 1 << 20;
  const data = bigData(5 * (1 << 20));
  const entry = await drive.upload("folder", "gross.bin", data, "Laptop");
  assert.equal(entry.md5, SparkMD5.ArrayBuffer.hash(data));
  assert.equal(srv.sessions, 1, "keine neue Sitzung");
  assert.equal(srv.statusCalls, 1, "einmal nachgefragt, wie viel angekommen ist");
  const totalSent = srv.sent.reduce((a, b) => a + b, 0);
  assert.ok(totalSent < data.byteLength + (1 << 20), `nur der fehlende Rest wurde neu gesendet (${totalSent})`);
});

test("Upload scheitert ganz: der nächste Versuch setzt die Sitzung fort", async () => {
  const srv = uploadServer({ dropAt: [2, 3, 4, 5] });
  const drive = new DriveClient(creds, async () => {});
  drive.chunkSize = 1 << 20;
  const data = bigData(4 * (1 << 20) + 1000);
  const e = await fails(drive.upload("folder", "gross.bin", data, "Laptop"));
  assert.ok(e.network);
  const before = srv.received.length;
  assert.ok(before > 1 << 20);
  const entry = await drive.upload("folder", "gross.bin", data, "Laptop");
  assert.equal(entry.md5, SparkMD5.ArrayBuffer.hash(data));
  assert.equal(srv.sessions, 1, "dieselbe Sitzung fortgesetzt");
});

test("Sync: zwei Übertragungen hintereinander ohne Antwort brechen den Lauf ab, ohne Dateien zurückzustellen", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  for (const p of ["a.md", "b.md", "c.md"]) a.vault.set(p, buf(p));
  const real = drive.upload.bind(drive);
  drive.upload = async () => { throw new DriveError("Zeitüberschreitung", 0, "timeout", "file"); };
  const e = await fails(a.sync());
  assert.deepEqual([e.kind, e.scope, e.network], ["timeout", "sync", true]);
  assert.deepEqual(a.state.failures, {}, "nicht die Dateien sind schuld");
  drive.upload = real;
  assert.equal((await a.sync()).uploaded, 3);
});

test("Sync: eine einzelne zu langsame Datei wird zurückgestellt, der Rest läuft", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  for (const p of ["a.md", "video.mp4", "c.md"]) a.vault.set(p, buf(p));
  const real = drive.upload.bind(drive);
  drive.upload = async (...args: Parameters<typeof real>) => {
    if (args[1] === "video.mp4") throw new DriveError("Zeitüberschreitung", 0, "timeout", "file");
    return real(...args);
  };
  const r = await a.sync();
  assert.deepEqual([r.uploaded, r.errors.length], [2, 1]);
  assert.ok(a.state.failures!["video.mp4"]);
});

test("Sync: Verbindungsabbruch während des Laufs – nichts geht verloren, nächster Lauf macht weiter", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop"), b = device(drive, "Handy");
  for (let i = 0; i < 6; i++) a.vault.set(`n${i}.md`, buf(`N${i}`));
  const real = drive.upload.bind(drive);
  let n = 0;
  drive.upload = async (...args: Parameters<typeof real>) => {
    if (++n === 4) throw new DriveError("Keine Verbindung", 0, "offline", "sync");
    return real(...args);
  };
  await fails(a.sync());
  drive.upload = real;
  const r = await a.sync();
  assert.equal(r.uploaded, 3);
  await b.sync();
  assert.equal(b.vault.data.size, 6);
});
