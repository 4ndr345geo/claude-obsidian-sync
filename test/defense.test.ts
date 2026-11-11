import { test } from "node:test";
import assert from "node:assert/strict";
import { BackupStore } from "../src/backup";
import { checkId, checkOutgoing, DriveClient, DriveError, q } from "../src/drive";
import { MAX_TEXT_BYTES } from "../src/sync";
import { setRequestHandler } from "./obsidian-mock";
import { FakeDrive, FakeVault, buf, device } from "./fakes";

/** Runs `fn` once right after the next listing of Drive (full list or change feed). */
function afterListing(drive: FakeDrive, fn: () => void) {
  const list = drive.listFiles.bind(drive), changes = drive.listChanges.bind(drive);
  const restore = () => { drive.listFiles = list; drive.listChanges = changes; };
  drive.listFiles = async () => { const out = await list(); restore(); fn(); return out; };
  drive.listChanges = async (t: string) => { const out = await changes(t); restore(); fn(); return out; };
}

test("Q-Injection: Werte können die Suchanfrage nicht verlassen", () => {
  assert.equal(q("Obsidian – Vault"), "Obsidian – Vault");
  assert.equal(q("a' or name contains '"), "a\\' or name contains \\'");
  assert.equal(q("a\\' or 1=1"), "a\\\\\\' or 1=1");
  assert.equal(q("x\u0000\n\r\t\u001f\u007fy"), "xy");
  // Ergebnis enthält kein unmaskiertes ' mehr: jede ' ist von einer ungeraden Zahl \ angeführt
  for (const evil of ["'", "\\'", "\\\\'", "a'b'c", "\\", "'\\'"]) {
    const out = q(evil);
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== "'") continue;
      let n = 0; for (let j = i - 1; j >= 0 && out[j] === "\\"; j--) n++;
      assert.equal(n % 2, 1, `${JSON.stringify(evil)} -> ${out}`);
    }
  }
});

test("Datei-IDs von Google werden streng geprüft", () => {
  assert.equal(checkId("1AbC-_9"), "1AbC-_9");
  for (const bad of ["", "a'b", "a/b", "../x", "a b", "a\nb", 5, null, "x".repeat(201)]) {
    assert.throws(() => checkId(bad), DriveError, String(bad));
  }
});

test("Ausgehende Anfragen: nur HTTPS zu Google, keine Zeilenumbrüche in Headern", () => {
  checkOutgoing({ url: "https://www.googleapis.com/drive/v3/files?q=x", headers: { Authorization: "Bearer abc" } });
  checkOutgoing({ url: "https://oauth2.googleapis.com/token", contentType: "application/x-www-form-urlencoded" });
  const blocked = [
    { url: "http://www.googleapis.com/drive/v3/files" },
    { url: "https://evil.example/upload" },
    { url: "https://www.googleapis.com.evil.example/x" },
    { url: "https://user:pw@www.googleapis.com/x" },
    { url: "https://www.googleapis.com/x\r\nX-Evil: 1" },
    { url: "https://www.googleapis.com/x", headers: { Authorization: "Bearer a\r\nX-Evil: 1" } },
    { url: "https://www.googleapis.com/x", headers: { "X-A\nB": "1" } },
    { url: "https://www.googleapis.com/x", contentType: "text/plain\r\nX-Evil: 1" },
    { url: "nicht-mal-eine-url" },
  ];
  for (const p of blocked) assert.throws(() => checkOutgoing(p), DriveError, JSON.stringify(p));
});

test("Zugriffstoken mit Zeilenumbruch wird nicht verwendet", async () => {
  setRequestHandler(() => ({ status: 200, headers: {}, json: { access_token: "abc\r\nX-Evil: 1", expires_in: 3600 } }));
  const e = await new DriveClient(() => ({ clientId: "i", clientSecret: "s", refreshToken: "t" }), async () => {})
    .accountEmail().catch((x) => x);
  assert.ok(e instanceof DriveError);
  assert.match(e.message, /Unerwartete Antwort von der Google-Anmeldung/);
});

test("Upload-Adresse von Google, die woanders hinzeigt, wird nicht verwendet", async () => {
  setRequestHandler(((p: { url: string }) => {
    if (p.url.includes("oauth2")) return { status: 200, headers: {}, json: { access_token: "tok", expires_in: 3600 } };
    return { status: 200, headers: { location: "https://evil.example/upload?id=1" }, json: {} };
  }) as never);
  const drive = new DriveClient(() => ({ clientId: "i", clientSecret: "s", refreshToken: "t" }), async () => {});
  const e = await drive.upload("f", "gross.bin", new ArrayBuffer(5 << 20), "Laptop").catch((x) => x);
  assert.match((e as Error).message, /Upload-Sitzung konnte nicht gestartet werden/);
});

test("Optimistic Concurrency: Änderung eines anderen Geräts zwischen Liste und Upload wird zusammengeführt, nicht überschrieben", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop"), b = device(drive, "Handy");
  a.vault.set("n.md", buf("1\n2\n3\n4\n5"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("1 Laptop\n2\n3\n4\n5"));
  // Das Handy lädt seine Änderung hoch, genau nachdem der Laptop die Liste gelesen hat.
  afterListing(drive, () => {
    const [id, f] = [...drive.files.entries()][0];
    drive.files.set(id, { ...f, data: buf("1\n2\n3\n4\n5 Handy"), device: "Handy" });
  });
  const r = await a.sync();
  const expected = "1 Laptop\n2\n3\n4\n5 Handy";
  assert.equal(a.vault.text("n.md"), expected, "Laptop hat die Handy-Änderung übernommen");
  assert.equal(new TextDecoder().decode([...drive.files.values()][0].data), expected, "nichts überschrieben");
  assert.deepEqual([r.errors.length, r.merged], [0, 1]);
});

test("Optimistic Concurrency: geänderte Datei wird nicht gelöscht", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop"), b = device(drive, "Handy");
  a.vault.set("n.md", buf("v1"));
  await a.sync(); await b.sync();
  a.vault.remove("n.md");
  // Das Handy ändert die Notiz, während der Laptop gerade löschen will.
  afterListing(drive, () => {
    const [id, f] = [...drive.files.entries()][0];
    drive.files.set(id, { ...f, data: buf("v2 vom Handy") });
  });
  await a.sync();
  assert.equal([...drive.files.values()].filter((f) => f.trashed).length, 0, "nicht gelöscht");
  await a.sync();
  assert.equal(a.vault.text("n.md"), "v2 vom Handy", "geänderte Version kommt zurück");
});

test("Memory Guard: zu große Dateien werden vor dem Lesen abgefangen, nicht gelöscht, Rest läuft", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop"), b = device(drive, "Handy");
  a.vault.set("klein.md", buf("k"));
  a.vault.set("video.mp4", buf("x".repeat(2000)));
  await a.sync();
  b.limits.maxFileBytes = 1000;
  let reads = 0;
  const read = b.vault.readBinary.bind(b.vault);
  b.vault.readBinary = async (f) => { reads++; return read(f); };
  const r = await b.sync();
  assert.equal(b.vault.text("klein.md"), "k");
  assert.equal(b.vault.text("video.mp4"), undefined, "nicht heruntergeladen");
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /video\.mp4: Zu groß für dieses Gerät/);
  // lokal vorhandene Riesendatei: wird nicht gelesen
  b.vault.set("datenbank.sqlite", buf("y".repeat(5000)));
  reads = 0;
  await b.sync(false, true);
  assert.equal(reads, 0, "Riesendatei nicht in den Speicher geladen");
  assert.ok([...drive.files.values()].every((f) => !f.trashed), "nichts gelöscht");
  assert.ok(![...drive.files.values()].some((f) => f.path === "datenbank.sqlite"));
});

test("Memory Guard: Notizen über 15 MB werden nicht als Text zusammengeführt", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop"), b = device(drive, "Handy");
  const big = "Zeile\n".repeat(Math.ceil((MAX_TEXT_BYTES + 10) / 6));
  a.vault.set("riesig.md", buf(big));
  await a.sync(); await b.sync();
  a.vault.set("riesig.md", buf("Laptop\n" + big));
  b.vault.set("riesig.md", buf(big + "Handy\n"));
  await a.sync();
  const r = await b.sync();
  assert.deepEqual([r.merged, r.marked.length, r.conflicts.length], [0, 0, 1], "Konfliktkopie statt Text-Merge");
  assert.ok(![...b.vault.hidden.keys()].some((k) => k.includes("/base/")), "keine Basis-Kopie für Riesennotizen");
});

test("Sicherungen: höchstens 50 Versionen pro Datei", async () => {
  const v = new FakeVault();
  const store = new BackupStore(v.adapter as never, "bk", () => ({ enabled: true, keepDays: 30, maxTotalBytes: 1e9, maxFileBytes: 1e6, maxVersionsPerFile: 50 }));
  const now = Date.parse("2026-11-11T12:00:00");
  for (let i = 0; i < 55; i++) {
    store.beginRun(new Date(now - (55 - i) * 60_000));
    await store.save("n.md", buf(`v${i}`));
    await store.save(`einmal${i % 2}.md`, buf("x"));
  }
  await store.prune(now);
  const list = await store.list();
  const versions = list.filter((e) => e.original === "n.md");
  assert.equal(versions.length, 50);
  assert.equal(new TextDecoder().decode(await store.read(versions[0].backupPath)), "v54", "neueste bleibt");
  assert.equal(new TextDecoder().decode(await store.read(versions[49].backupPath)), "v5");
});
