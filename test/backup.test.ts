import { test } from "node:test";
import assert from "node:assert/strict";
import SparkMD5 from "spark-md5";
import { BackupStore } from "../src/backup";
import { DriveClient } from "../src/drive";
import { decodeStrict } from "../src/sync";
import { setRequestHandler } from "./obsidian-mock";
import { FakeDrive, FakeVault, buf, device } from "./fakes";

const DIR = ".obsidian/plugins/gdrive-vault-sync/backups";
const dec = new TextDecoder();
const backupsOf = (v: FakeVault) => [...v.hidden.keys()].filter((k) => k.startsWith(DIR + "/"));

function setup() {
  const drive = new FakeDrive();
  return { drive, a: device(drive, "Laptop"), b: device(drive, "Handy") };
}

test("Download überschreibt eine Notiz: die bisherige Version wird gesichert", async () => {
  const { a, b } = setup();
  a.vault.set("n.md", buf("alt"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("neu"));
  await a.sync();
  const r = await b.sync();
  assert.equal(b.vault.text("n.md"), "neu");
  assert.equal(r.backedUp, 1);
  const files = backupsOf(b.vault);
  assert.equal(files.length, 1);
  assert.match(files[0], /backups\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}-\d{3}\/n\.md$/);
  assert.equal(b.vault.hiddenText(files[0]), "alt");
  assert.equal(backupsOf(a.vault).length, 0, "Upload ändert lokal nichts, also keine Sicherung");
});

test("Löschen: Notiz und Einstellungsdatei werden vorher gesichert", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop", true), b = device(drive, "Handy", true);
  a.vault.set("weg.md", buf("Inhalt"));
  a.vault.setHidden(".obsidian/snippets/farben.css", "body{}");
  await a.sync(); await b.sync();
  a.vault.remove("weg.md");
  a.vault.hidden.delete(".obsidian/snippets/farben.css");
  await a.sync();
  const r = await b.sync();
  assert.equal(r.deleted, 2);
  const list = await b.engine.backups.list();
  assert.deepEqual(list.map((x) => x.original).sort(), [".obsidian/snippets/farben.css", "weg.md"]);
});

test("Zusammenführen: die lokale Version vor dem Zusammenführen bleibt gesichert", async () => {
  const { a, b } = setup();
  a.vault.set("n.md", buf("1\n2\n3\n4\n5"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("1 Laptop\n2\n3\n4\n5"));
  b.vault.set("n.md", buf("1\n2\n3\n4\n5 Handy"));
  await a.sync();
  await b.sync();
  const [only] = await b.engine.backups.list();
  assert.equal(dec.decode(await b.engine.backups.read(only.backupPath)), "1\n2\n3\n4\n5 Handy");
});

test("Wiederherstellen: alte Version zurück, ersetzte Version wird ebenfalls gesichert, Sync überträgt sie", async () => {
  const { a, b } = setup();
  a.vault.set("n.md", buf("gut"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("versehentlich gelöscht"));
  await a.sync(); await b.sync();
  const [entry] = await b.engine.backups.list();
  await new Promise((r) => setTimeout(r, 2));
  await b.engine.restore(entry.backupPath, entry.original);
  assert.equal(b.vault.text("n.md"), "gut");
  assert.equal((await b.engine.backups.list()).length, 2);
  await b.sync(); await a.sync();
  assert.equal(a.vault.text("n.md"), "gut");
});

test("Wiederherstellen lehnt unsichere Zielpfade ab", async () => {
  const { a } = setup();
  await assert.rejects(a.engine.restore(`${DIR}/x`, "../draussen.md"), /Ungültiger Pfad/);
});

test("Sicherung schlägt fehl: Datei bleibt unverändert, nur sie wird zurückgestellt", async () => {
  const { a, b } = setup();
  a.vault.set("n.md", buf("alt")); a.vault.set("m.md", buf("m alt"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("neu")); a.vault.set("m.md", buf("m neu"));
  await a.sync();
  const write = b.vault.adapter.writeBinary;
  b.vault.adapter.writeBinary = async (p: string, d: ArrayBuffer) => {
    if (p.endsWith("/n.md")) throw new Error("ENOSPC: no space left on device");
    return write(p, d);
  };
  const r = await b.sync();
  assert.equal(b.vault.text("n.md"), "alt", "nicht überschrieben ohne Sicherung");
  assert.equal(b.vault.text("m.md"), "m neu");
  assert.match(r.errors[0], /Sicherung der bisherigen Version fehlgeschlagen/);
  b.vault.adapter.writeBinary = write;
  await b.sync(false, true);
  assert.equal(b.vault.text("n.md"), "neu");
});

test("Sicherung abgeschaltet oder Datei zu groß: kein Backup, Sync läuft normal", async () => {
  const { a, b } = setup();
  a.vault.set("gross.bin", buf("x".repeat(100))); a.vault.set("n.md", buf("1"));
  await a.sync(); await b.sync();
  b.backup.maxFileBytes = 50;
  a.vault.set("gross.bin", buf("y".repeat(100))); a.vault.set("n.md", buf("2"));
  await a.sync();
  assert.equal((await b.sync()).backedUp, 1);
  b.backup.enabled = false;
  a.vault.set("n.md", buf("3"));
  await a.sync();
  assert.equal((await b.sync()).backedUp, 0);
  assert.equal(b.vault.text("n.md"), "3");
});

test("Aufräumen: alte und überzählige Sicherungen werden entfernt, die laufende nie", async () => {
  const v = new FakeVault();
  const o = { enabled: true, keepDays: 30, maxTotalBytes: 25, maxFileBytes: 100 };
  const store = new BackupStore(v.adapter as never, DIR, () => o);
  const day = 24 * 3600_000, now = Date.parse("2026-11-11T12:00:00");
  for (const [age, name] of [[40, "uralt"], [3, "a"], [2, "b"], [1, "c"]] as const) {
    store.beginRun(new Date(now - age * day));
    await store.save(`${name}.md`, buf("0123456789"));
  }
  store.beginRun(new Date(now));
  await store.save("jetzt.md", buf("0123456789"));
  assert.equal((await store.list()).length, 5);
  await store.prune(now);
  // uralt: zu alt; danach 40 Bytes > 25: a und b fallen weg, c und jetzt bleiben (20 Bytes)
  assert.deepEqual((await store.list()).map((e) => e.original), ["jetzt.md", "c.md"]);
});

test("Fallback: Notiz ohne gültiges UTF-8 wird nicht zusammengeführt, beide Fassungen bleiben", async () => {
  assert.equal(decodeStrict(buf("ä"), new Uint8Array([0xe4, 0x20]).buffer), null);
  assert.deepEqual(decodeStrict(buf("ä"), buf("ö")), ["ä", "ö"]);
  const { a, b } = setup();
  const latin1 = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0))).buffer as ArrayBuffer;
  a.vault.set("alt.txt", latin1("Gr\xfc\xdfe\nZeile 2"));
  await a.sync(); await b.sync();
  a.vault.set("alt.txt", latin1("Gr\xfc\xdfe Laptop\nZeile 2"));
  b.vault.set("alt.txt", latin1("Gr\xfc\xdfe\nZeile 2 Handy"));
  await a.sync();
  const r = await b.sync();
  assert.equal(r.conflicts.length, 1, "Konfliktkopie statt kaputtem Zusammenführen");
  const bytes = [...b.vault.data.values()].map((d) => new Uint8Array(d));
  assert.ok(bytes.every((x) => !x.includes(0xef)), "keine Ersatzzeichen (U+FFFD) entstanden");
});

test("Fallback: Upload in Teilen funktioniert auf dem Gerät nicht – große Dateien gehen am Stück", async () => {
  let sessions = 0, whole = 0;
  setRequestHandler(((p: { url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer }) => {
    if (p.url.includes("oauth2")) return { status: 200, headers: {}, json: { access_token: "a", expires_in: 3600 } };
    if (p.url.includes("uploadType=resumable")) {
      sessions++;
      return { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=s${sessions}` }, json: {} };
    }
    const range = p.headers?.["Content-Range"];
    if (range) throw new Error("net::ERR_INVALID_REDIRECT"); // dieses Gerät kann mit 308 nicht umgehen
    whole++;
    return { status: 200, headers: {}, json: { id: "f1", name: "gross.bin", md5Checksum: SparkMD5.ArrayBuffer.hash(p.body!) } };
  }) as never);
  const drive = new DriveClient(() => ({ clientId: "i", clientSecret: "s", refreshToken: "t" }), async () => {});
  drive.chunkSize = 1 << 20;
  const data = new Uint8Array(5 << 20).buffer;
  const e1 = await drive.upload("f", "gross.bin", data, "Laptop");
  assert.equal(e1.md5, SparkMD5.ArrayBuffer.hash(data));
  assert.ok(drive.chunkedUnsupported);
  await drive.upload("f", "gross2.bin", data, "Laptop");
  assert.equal(whole, 2, "zweiter Upload direkt am Stück");
});

test("Fallback: Papierkorb nicht verfügbar – Datei wird trotzdem gelöscht (vorher gesichert)", async () => {
  const { a, b } = setup();
  a.vault.set("weg.md", buf("x"));
  await a.sync(); await b.sync();
  a.vault.remove("weg.md");
  await a.sync();
  const fm = (b.engine as unknown as { app: { fileManager: { trashFile: unknown }; vault: Record<string, unknown> } }).app;
  fm.fileManager.trashFile = async () => { throw new Error("trash not available"); };
  const trashed: boolean[] = [];
  fm.vault.trash = async (f: { path: string }, system: boolean) => {
    trashed.push(system);
    if (system) throw new Error("kein System-Papierkorb");
    b.vault.remove(f.path);
  };
  const r = await b.sync();
  assert.deepEqual([r.deleted, r.errors.length], [1, 0]);
  assert.deepEqual(trashed, [true, false], "System-Papierkorb, dann .trash im Vault");
  assert.equal(b.vault.text("weg.md"), undefined);
  assert.equal((await b.engine.backups.list())[0].original, "weg.md");
});
