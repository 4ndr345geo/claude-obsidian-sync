import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEntry } from "../src/log";
import { FakeDrive, buf, device } from "./fakes";

function setup() {
  const drive = new FakeDrive();
  return { drive, a: device(drive, "Laptop"), b: device(drive, "Handy") };
}

test("Upload schlägt beim Markieren eines Konflikts fehl: Notiz wächst nicht bei jedem Versuch", async () => {
  const { drive, a, b } = setup();
  a.vault.set("n.md", buf("Anfang\n\nOriginal\n\nEnde"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("Anfang\n\nLaptop\n\nEnde"));
  b.vault.set("n.md", buf("Anfang\n\nHandy\n\nEnde"));
  await a.sync();
  drive.failUpload = true;
  for (let i = 0; i < 3; i++) {
    const r = await b.sync();
    assert.equal(r.errors.length, 1);
    assert.equal(b.vault.text("n.md"), "Anfang\n\nHandy\n\nEnde", "lokal unverändert, solange der Upload scheitert");
  }
  drive.failUpload = false;
  const r = await b.sync();
  assert.deepEqual(r.marked, ["n.md"]);
  const text = b.vault.text("n.md")!;
  assert.equal(text.split("[!warning] Sync-Konflikt").length - 1, 1, "genau eine Markierung");
  assert.ok(text.includes("Laptop") && text.includes("Handy"));
  await a.sync();
  assert.equal(a.vault.text("n.md"), text);
});

test("Upload schlägt bei Bild-Konflikt fehl: es entsteht nur eine Konfliktkopie", async () => {
  const { drive, a, b } = setup();
  a.vault.set("bild.png", buf("v0"));
  await a.sync(); await b.sync();
  a.vault.set("bild.png", buf("vom Laptop"));
  await a.sync();
  b.vault.set("bild.png", buf("vom Handy"));
  drive.failUpload = true;
  for (let i = 0; i < 3; i++) await b.sync();
  drive.failUpload = false;
  await b.sync(); await a.sync(); await b.sync();
  const copies = [...b.vault.data.keys()].filter((p) => p.includes("Konflikt"));
  assert.equal(copies.length, 1, copies.join(", "));
  assert.deepEqual([...a.vault.data.keys()].sort(), [...b.vault.data.keys()].sort());
  const contents = [...a.vault.data.keys()].map((p) => a.vault.text(p)).sort();
  assert.deepEqual(contents, ["vom Handy", "vom Laptop"]);
});

test("Drive-Ordner gelöscht: lokal wird nichts gelöscht, alles wird neu hochgeladen", async () => {
  const { drive, a } = setup();
  for (let i = 0; i < 5; i++) a.vault.set(`n${i}.md`, buf(`Notiz ${i}`));
  await a.sync();
  for (const f of drive.files.values()) f.trashed = true; // Ordner samt Inhalt im Papierkorb
  drive.folderGone = true;
  const r = await a.sync();
  assert.equal(r.deleted, 0);
  assert.equal(r.uploaded, 5);
  assert.equal(a.vault.data.size, 5);
});

test("Beschädigter Download wird nicht in den Vault geschrieben", async () => {
  const { drive, a, b } = setup();
  a.vault.set("n.md", buf("Version 1"));
  await a.sync(); await b.sync();
  a.vault.set("n.md", buf("Version 2 mit mehr Text"));
  a.vault.set("neu.md", buf("ganz neue Notiz"));
  await a.sync();
  drive.corruptDownload = true;
  const r = await b.sync();
  assert.equal(r.errors.length, 2);
  assert.equal(b.vault.text("n.md"), "Version 1");
  assert.equal(b.vault.text("neu.md"), undefined);
  drive.corruptDownload = false;
  await b.sync();
  assert.equal(b.vault.text("n.md"), "Version 2 mit mehr Text");
  assert.equal(b.vault.text("neu.md"), "ganz neue Notiz");
});

test("Protokoll: Dateinamen und Fehlertexte von außen werden nicht als Markdown/HTML ausgeführt", () => {
  const evil = "x]] ![](https://example.invalid/p.png) <iframe src=x>.md";
  const entry = formatEntry(new Date(), 100, {
    uploaded: 0, downloaded: 1, deleted: 0, merged: 0, marked: [], conflicts: [], errors: ["e"], configChanged: false,
    events: [{ kind: "down", path: evil }, { kind: "down", path: "Ordner/gute_Notiz.md" },
      { kind: "error", path: "a.md", detail: "kaputt `x` <script>alert(1)</script>\n## Überschrift" }],
  }, "abgebrochen <b>fett</b> `c`", () => false)!;
  assert.ok(entry.includes("[[Ordner/gute_Notiz]]"));
  assert.ok(!entry.includes("[[x]]"));
  for (const line of entry.split("\n").slice(1)) {
    // alles Fremde steht vollständig innerhalb eines Code-Abschnitts
    const outside = line.replace(/`[^`]*`/g, "");
    assert.ok(!/[<>]|!\[|\]\(/.test(outside), line);
  }
  assert.equal(entry.split("\n").filter((l) => l.startsWith("## ")).length, 1);
});
