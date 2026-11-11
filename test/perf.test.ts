import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveClient, DriveError } from "../src/drive";
import { FULL_LIST_EVERY } from "../src/sync";
import { setRequestHandler } from "./obsidian-mock";
import { FakeDrive, buf, device } from "./fakes";

function counting(drive: FakeDrive) {
  const n: Record<string, number> = {};
  for (const m of ["listFiles", "listChanges", "startPageToken", "upload", "download"] as const) {
    const orig = (drive as any)[m].bind(drive);
    (drive as any)[m] = async (...a: unknown[]) => { n[m] = (n[m] ?? 0) + 1; return orig(...a); };
  }
  return n;
}

test("Großer Vault: ruhige Läufe fragen nur nach Änderungen statt alles aufzulisten", async () => {
  const drive = new FakeDrive();
  const n = counting(drive);
  const a = device(drive, "Laptop"), b = device(drive, "Handy");
  for (let i = 0; i < 300; i++) a.vault.set(`O${i % 10}/N${i}.md`, buf(`n${i}`));
  await a.sync(); await b.sync();
  for (const k of Object.keys(n)) n[k] = 0;
  await a.sync();
  assert.deepEqual([n.listFiles ?? 0, n.listChanges], [0, 1], "Leerlauf: nur Änderungsliste");
  // Änderungen anderer Geräte kommen über die Änderungsliste an
  b.vault.set("O1/N1.md", buf("geändert")); b.vault.remove("O2/N2.md"); b.vault.set("neu.md", buf("neu"));
  await b.sync();
  for (const k of Object.keys(n)) n[k] = 0;
  const r = await a.sync();
  assert.equal(n.listFiles ?? 0, 0);
  assert.deepEqual([r.downloaded, r.deleted], [2, 1]);
  assert.equal(a.vault.text("O1/N1.md"), "geändert");
  assert.equal(a.vault.text("O2/N2.md"), undefined);
  // manuelle Synchronisierung: vollständige Liste zur Sicherheit
  for (const k of Object.keys(n)) n[k] = 0;
  await a.sync(false, true);
  assert.equal(n.listFiles, 1);
});

test("Volle Liste spätestens nach einer Stunde, nach „Datei nicht gefunden“ und bei neuem Ordner", async () => {
  const drive = new FakeDrive();
  const n = counting(drive);
  const a = device(drive, "Laptop");
  a.vault.set("n.md", buf("x"));
  await a.sync();
  n.listFiles = 0;
  a.state.remote!.fullAt = Date.now() - FULL_LIST_EVERY - 1;
  await a.sync();
  assert.equal(n.listFiles, 1, "nach einer Stunde");
  n.listFiles = 0;
  await a.sync();
  assert.equal(n.listFiles, 0);
  // eine Datei ist in Drive verschwunden, ohne dass die Änderungsliste es meldet
  const b = device(drive, "Handy");
  await b.sync();
  b.vault.set("n.md", buf("y")); await b.sync();
  const dl = drive.download.bind(drive);
  drive.download = async () => { throw new DriveError("weg", 404, "notFound", "file"); };
  await a.sync();
  drive.download = dl;
  n.listFiles = 0;
  await a.sync(false, false);
  assert.equal(n.listFiles, 1, "nach 404 vollständige Liste");
});

test("Rückfall: ohne Änderungsliste wird jedes Mal alles aufgelistet, Sync funktioniert", async () => {
  const drive = new FakeDrive();
  drive.supportsChanges = false;
  const n = counting(drive);
  const a = device(drive, "Laptop"), b = device(drive, "Handy");
  a.vault.set("n.md", buf("1"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("2"));
  await a.sync(); await b.sync();
  assert.equal(b.vault.text("n.md"), "2");
  assert.equal(n.listFiles, 4);
});

test("Parallele Übertragungen: höchstens 4 gleichzeitig, alle kommen an", async () => {
  const drive = new FakeDrive();
  let running = 0, max = 0;
  for (const m of ["upload", "download"] as const) {
    const orig = (drive as any)[m].bind(drive);
    (drive as any)[m] = async (...a: unknown[]) => {
      running++; max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      try { return await orig(...a); } finally { running--; }
    };
  }
  const a = device(drive, "Laptop"), b = device(drive, "Handy");
  for (let i = 0; i < 40; i++) a.vault.set(`Ordner/Unter${i % 3}/N${i}.md`, buf(`n${i}`));
  const t = Date.now();
  const r = await a.sync();
  const ms = Date.now() - t;
  assert.equal(r.uploaded, 40);
  assert.equal(max, 4);
  assert.ok(ms < 40 * 5, `schneller als nacheinander (${ms} ms)`);
  max = 0;
  assert.equal((await b.sync()).downloaded, 40);
  assert.equal(max, 4);
  assert.deepEqual([...b.vault.data.keys()].sort(), [...a.vault.data.keys()].sort());
});

test("Erstsync: jede Datei wird nur einmal gelesen, der Stand nicht nach jeder Datei gespeichert", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  for (let i = 0; i < 200; i++) a.vault.set(`N${i}.md`, buf(`n${i}`));
  let reads = 0, saves = 0;
  const rb = a.vault.readBinary.bind(a.vault);
  a.vault.readBinary = async (f) => { reads++; return rb(f); };
  (a.engine as any).persist = async () => { saves++; };
  await a.sync();
  assert.equal(reads, 200);
  assert.ok(saves <= 3, `${saves} Speichervorgänge`);
});

test("Gelesene Daten werden nicht verwendet, wenn die Datei inzwischen geändert wurde", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  a.vault.set("n.md", buf("alt"));
  const up = drive.upload.bind(drive);
  let first = true;
  drive.upload = async (...args: Parameters<typeof up>) => {
    if (first) { first = false; }
    return up(...args);
  };
  // Änderung nach dem Einlesen, vor dem Upload
  const ex = (a.engine as any).execute.bind(a.engine);
  (a.engine as any).execute = async (...args: unknown[]) => { a.vault.set("n.md", buf("neu während des Laufs")); return ex(...args); };
  await a.sync();
  const [f] = [...drive.files.values()];
  assert.equal(new TextDecoder().decode(f.data), "neu während des Laufs");
});

test("Änderungsliste von Google: Seiten, gelöscht, Papierkorb, verschoben", async () => {
  const pages: Record<string, unknown> = {
    t1: { nextPageToken: "t2", changes: [
      { fileId: "a", removed: false, file: { id: "a", name: "a.md", md5Checksum: "1", parents: ["F"], trashed: false, mimeType: "text/markdown" } },
      { fileId: "b", removed: true },
      { fileId: "c", file: { id: "c", name: "c.md", parents: ["F"], trashed: true } },
    ] },
    t2: { newStartPageToken: "t3", changes: [
      { fileId: "d", file: { id: "d", name: "d.md", parents: ["anderer Ordner"], trashed: false } },
      { fileId: "e", file: { id: "e", name: "e.md", md5Checksum: "5", size: "12", parents: ["F"], trashed: false } },
      { fileId: "a", file: { id: "a", name: "a.md", md5Checksum: "2", parents: ["F"], trashed: false } },
      { fileId: "x'y", file: { id: "x'y", name: "böse.md", parents: ["F"] } },
    ] },
  };
  setRequestHandler(((p: { url: string }) => {
    if (p.url.includes("oauth2")) return { status: 200, headers: {}, json: { access_token: "tok", expires_in: 3600 } };
    const token = new URL(p.url).searchParams.get("pageToken")!;
    return { status: 200, headers: {}, json: pages[token] };
  }) as never);
  const drive = new DriveClient(() => ({ clientId: "i", clientSecret: "s", refreshToken: "t" }), async () => {});
  const r = await drive.listChanges("t1", "F");
  assert.equal(r.token, "t3");
  assert.deepEqual(r.changed.map((e) => [e.id, e.md5]).sort(), [["a", "2"], ["e", "5"]]);
  assert.equal(r.changed.find((e) => e.id === "e")!.size, 12);
  assert.deepEqual(r.removed.sort(), ["b", "c", "d", "x'y"]);
});
