import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncEngine, SyncState } from "../src/sync";
import { FakeDrive, FakeVault, buf } from "./fakes";

function device(drive: FakeDrive, name: string) {
  const vault = new FakeVault();
  const state: SyncState = { base: {}, cache: {}, folderId: "", folderName: "" };
  const app = { vault, fileManager: { trashFile: async (f: { path: string }) => vault.remove(f.path) } };
  const engine = new SyncEngine(app as never, drive as never, state,
    () => ({ folderName: "Test", deviceName: name, excludes: [".trash/**"] }), ".obsidian/plugins/x/base", async () => {});
  return { vault, sync: () => engine.run(), name };
}

function setup() {
  const drive = new FakeDrive();
  return { drive, a: device(drive, "Laptop"), b: device(drive, "Handy") };
}

test("neue Notiz kommt auf dem anderen Gerät an", async () => {
  const { a, b } = setup();
  a.vault.set("Ordner/Notiz.md", buf("Hallo"));
  await a.sync(); await b.sync();
  assert.equal(b.vault.text("Ordner/Notiz.md"), "Hallo");
  const r = await a.sync();
  assert.deepEqual([r.uploaded, r.downloaded], [0, 0]);
});

test("Änderungen an verschiedenen Stellen werden automatisch zusammengeführt", async () => {
  const { a, b } = setup();
  a.vault.set("n.md", buf("Zeile 1\nZeile 2\nZeile 3\nZeile 4\nZeile 5"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("Zeile 1 (Laptop)\nZeile 2\nZeile 3\nZeile 4\nZeile 5"));
  b.vault.set("n.md", buf("Zeile 1\nZeile 2\nZeile 3\nZeile 4\nZeile 5 (Handy)"));
  await a.sync();
  const r = await b.sync();
  await a.sync();
  const expected = "Zeile 1 (Laptop)\nZeile 2\nZeile 3\nZeile 4\nZeile 5 (Handy)";
  assert.equal(r.merged, 1);
  assert.equal(r.conflicts.length, 0);
  assert.equal(b.vault.text("n.md"), expected);
  assert.equal(a.vault.text("n.md"), expected);
});

test("kritische Änderung: wird in der Notiz markiert, nichts geht verloren", async () => {
  const { a, b } = setup();
  a.vault.set("n.md", buf("Einleitung\n\nOriginal\nSchluss"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("Einleitung neu\n\nLaptop-Text\nSchluss"));
  b.vault.set("n.md", buf("Einleitung\n\nHandy-Text\nSchluss")); // neuer
  await a.sync();
  const r = await b.sync();
  await a.sync();
  assert.deepEqual(r.marked, ["n.md"]);
  for (const d of [a, b]) {
    assert.equal(d.vault.getFiles().length, 1, "keine Konfliktkopie");
    const t = d.vault.text("n.md")!;
    assert.ok(t.startsWith("Einleitung neu\n"), "unkritische Änderung übernommen");
    assert.match(t, /> \[!warning\] Sync-Konflikt/);
    assert.ok(t.indexOf("> Handy-Text") < t.indexOf("> Laptop-Text"), "neuere Version zuerst");
    assert.ok(t.endsWith("\nSchluss"));
  }
  assert.equal(a.vault.text("n.md"), b.vault.text("n.md"));
});

test("Bild-Konflikt: neuere Version bleibt, ältere als Kopie", async () => {
  const { a, b } = setup();
  a.vault.set("bild.png", new Uint8Array([1]).buffer);
  await a.sync(); await b.sync();
  a.vault.set("bild.png", new Uint8Array([2]).buffer);
  b.vault.set("bild.png", new Uint8Array([3]).buffer);
  await a.sync();
  const r = await b.sync();
  await a.sync();
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0], /^bild \(Konflikt Laptop .*\)\.png$/);
  for (const d of [a, b]) {
    assert.deepEqual([...new Uint8Array(d.vault.data.get("bild.png")!)], [3]);
    assert.equal(d.vault.getFiles().length, 2);
  }
});

test("Löschen wird übertragen", async () => {
  const { a, b, drive } = setup();
  a.vault.set("weg.md", buf("x"));
  await a.sync(); await b.sync();
  b.vault.remove("weg.md");
  await b.sync(); await a.sync();
  assert.equal(a.vault.text("weg.md"), undefined);
  assert.equal((await drive.listFiles()).length, 0);
});

test("Bearbeiten schlägt Löschen: geänderte Datei bleibt erhalten", async () => {
  const { a, b } = setup();
  a.vault.set("n.md", buf("v1"));
  await a.sync(); await b.sync();
  a.vault.remove("n.md");
  b.vault.set("n.md", buf("v2"));
  await a.sync(); await b.sync(); await a.sync();
  assert.equal(a.vault.text("n.md"), "v2");
  assert.equal(b.vault.text("n.md"), "v2");
});

test("gleiche Notiz gleichzeitig auf zwei Geräten neu angelegt", async () => {
  const { a, b } = setup();
  a.vault.set("Tagebuch/2026-11-03.md", buf("# Tag\nvom Laptop"));
  b.vault.set("Tagebuch/2026-11-03.md", buf("# Tag\nvom Handy"));
  await a.sync(); await b.sync(); await a.sync();
  for (const d of [a, b]) {
    assert.equal(d.vault.getFiles().length, 1);
    const t = d.vault.text("Tagebuch/2026-11-03.md")!;
    assert.ok(t.startsWith("# Tag\n"));
    assert.ok(t.includes("vom Laptop") && t.includes("vom Handy"));
  }
});

test("Binärdateien (Bilder) werden übertragen", async () => {
  const { a, b } = setup();
  const img = new Uint8Array([0, 255, 1, 2, 3]).buffer;
  a.vault.set("Anhänge/bild.png", img);
  await a.sync(); await b.sync();
  assert.deepEqual(new Uint8Array(b.vault.data.get("Anhänge/bild.png")!), new Uint8Array(img));
});

test("ausgeschlossene Pfade werden ignoriert", async () => {
  const { a, drive } = setup();
  a.vault.set(".trash/alt.md", buf("x"));
  await a.sync();
  assert.equal((await drive.listFiles()).length, 0);
});
