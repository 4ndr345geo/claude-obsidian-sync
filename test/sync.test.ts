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

test("echter Konflikt: nichts geht verloren, Konfliktkopie wird überall angelegt", async () => {
  const { a, b } = setup();
  a.vault.set("n.md", buf("Original"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("Laptop-Text"));
  b.vault.set("n.md", buf("Handy-Text")); // newer
  await a.sync();
  const r = await b.sync();
  await a.sync();
  assert.equal(r.conflicts.length, 1);
  for (const d of [a, b]) {
    const texts = d.vault.getFiles().map((f) => d.vault.text(f.path)).sort();
    assert.deepEqual(texts, ["Handy-Text", "Laptop-Text"], d.name);
    assert.equal(d.vault.text("n.md"), "Handy-Text");
  }
  assert.match(r.conflicts[0], /^n \(Konflikt Laptop .*\)\.md$/);
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

test("gleiche Datei gleichzeitig auf zwei Geräten neu angelegt", async () => {
  const { a, b } = setup();
  a.vault.set("Tagebuch/2026-11-03.md", buf("vom Laptop"));
  b.vault.set("Tagebuch/2026-11-03.md", buf("vom Handy"));
  await a.sync(); await b.sync(); await a.sync();
  for (const d of [a, b]) {
    const texts = d.vault.getFiles().map((f) => d.vault.text(f.path)).sort();
    assert.deepEqual(texts, ["vom Handy", "vom Laptop"], d.name);
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
