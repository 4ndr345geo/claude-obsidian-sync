import { test } from "node:test";
import assert from "node:assert/strict";
import { MassDeleteError } from "../src/sync";
import { FakeDrive, FakeVault, buf, device } from "./fakes";
import { SyncEngine as E112 } from "./legacy/v1_1_2/sync";
import { SyncEngine as E120 } from "./legacy/v1_2_0/sync";
import { SyncEngine as E140 } from "./legacy/v1_4_0/sync";
import { SyncEngine as E151 } from "./legacy/v1_5_1/sync";

// Läuft die Sync-Logik der veröffentlichten Versionen (test/legacy) gegen die aktuelle.

/** A device running an older release of the sync engine, on the same fake Drive. */
function legacy(Engine: any, drive: FakeDrive, name: string, configEnabled = false) {
  const vault = new FakeVault();
  // Real Obsidian never lists files of the settings folder in its index:
  // writes there through the vault API end up "hidden".
  const create = vault.createBinary.bind(vault);
  vault.createBinary = async (p: string, d: ArrayBuffer) => {
    if (p.startsWith(".obsidian/")) { if (vault.hidden.has(p)) throw new Error("File already exists."); vault.setHidden(p, d); return; }
    return create(p, d);
  };
  const state = { base: {}, cache: {}, folderId: "", folderName: "" };
  const app = { vault, fileManager: { trashFile: async (f: { path: string }) => vault.remove(f.path) } };
  const config = { enabled: configEnabled, settings: true, appearance: true, plugins: true };
  const engine = new Engine(app, drive, state,
    () => ({ folderName: "Test", deviceName: name, excludes: [".trash/**"], config }),
    ".obsidian/plugins/gdrive-vault-sync/base", async () => {}, "gdrive-vault-sync");
  return { vault, sync: () => engine.run() };
}

const versions: [string, any][] = [["1.1.2", E112], ["1.2.0", E120], ["1.4.0", E140], ["1.5.1", E151]];

for (const [v, Engine] of versions) {
  test(`${v} ↔ aktuell: neu, ändern, löschen in beide Richtungen`, async () => {
    const drive = new FakeDrive();
    const neu = device(drive, "Neu"), alt = legacy(Engine, drive, "Alt");
    neu.vault.set("a/von-neu.md", buf("N1")); alt.vault.set("b/von-alt.md", buf("A1"));
    neu.vault.set("bild.png", buf("PNG1"));
    for (let i = 0; i < 2; i++) { await neu.sync(); await alt.sync(); }
    assert.equal(alt.vault.text("a/von-neu.md"), "N1"); assert.equal(neu.vault.text("b/von-alt.md"), "A1");
    assert.equal(alt.vault.text("bild.png"), "PNG1");
    alt.vault.set("a/von-neu.md", buf("N2 vom alten"));
    neu.vault.set("b/von-alt.md", buf("A2 vom neuen"));
    for (let i = 0; i < 2; i++) { await alt.sync(); await neu.sync(); }
    assert.equal(neu.vault.text("a/von-neu.md"), "N2 vom alten"); assert.equal(alt.vault.text("b/von-alt.md"), "A2 vom neuen");
    alt.vault.remove("bild.png");
    neu.vault.remove("b/von-alt.md");
    for (let i = 0; i < 2; i++) { await alt.sync(); await neu.sync(); }
    assert.equal(neu.vault.text("bild.png"), undefined); assert.equal(alt.vault.text("b/von-alt.md"), undefined);
    assert.deepEqual([...neu.vault.data.keys()].sort(), [...alt.vault.data.keys()].sort());
  });

  test(`${v} ↔ aktuell: gleichzeitige Änderungen werden zusammengeführt bzw. markiert`, async () => {
    const drive = new FakeDrive();
    const neu = device(drive, "Neu"), alt = legacy(Engine, drive, "Alt");
    neu.vault.set("n.md", buf("1\n2\n3\n4\n5")); neu.vault.set("k.md", buf("x\nOriginal\ny"));
    await neu.sync(); await alt.sync();
    neu.vault.set("n.md", buf("1 neu\n2\n3\n4\n5")); alt.vault.set("n.md", buf("1\n2\n3\n4\n5 alt"));
    neu.vault.set("k.md", buf("x\nNeu-Text\ny")); alt.vault.set("k.md", buf("x\nAlt-Text\ny"));
    await neu.sync(); await alt.sync(); await neu.sync(); await alt.sync();
    assert.equal(neu.vault.text("n.md"), "1 neu\n2\n3\n4\n5 alt");
    assert.equal(alt.vault.text("n.md"), neu.vault.text("n.md"));
    const k = neu.vault.text("k.md")!;
    assert.ok(k.includes("Neu-Text") && k.includes("Alt-Text") && k.includes("Sync-Konflikt"), k);
    assert.equal(alt.vault.text("k.md"), k);
  });

  test(`${v} ↔ aktuell: Bild auf beiden Geräten geändert – beide Versionen bleiben`, async () => {
    const drive = new FakeDrive();
    const neu = device(drive, "Neu"), alt = legacy(Engine, drive, "Alt");
    neu.vault.set("bild.png", buf("v0")); await neu.sync(); await alt.sync();
    neu.vault.set("bild.png", buf("vom neuen")); alt.vault.set("bild.png", buf("vom alten"));
    for (let i = 0; i < 2; i++) { await neu.sync(); await alt.sync(); }
    const contents = (vault: FakeVault) => [...vault.data.keys()].map((p) => vault.text(p)).sort();
    assert.deepEqual(contents(neu.vault), ["vom alten", "vom neuen"]);
    assert.deepEqual(contents(alt.vault), ["vom alten", "vom neuen"]);
  });
}

for (const [v, Engine] of versions.slice(2)) {
  test(`${v} ↔ aktuell: Einstellungs-Sync auf beiden Geräten`, async () => {
    const drive = new FakeDrive();
    const neu = device(drive, "Neu", true), alt = legacy(Engine, drive, "Alt", true);
    neu.vault.setHidden(".obsidian/app.json", '{"a":1,"b":1}');
    neu.vault.setHidden(".obsidian/plugins/dataview/main.js", "code");
    await neu.sync(); await alt.sync();
    assert.equal(alt.vault.hiddenText(".obsidian/plugins/dataview/main.js"), "code");
    neu.vault.setHidden(".obsidian/app.json", '{"a":2,"b":1}');
    alt.vault.setHidden(".obsidian/app.json", '{"a":1,"b":2}');
    for (let i = 0; i < 2; i++) { await neu.sync(); await alt.sync(); }
    assert.deepEqual(JSON.parse(neu.vault.hiddenText(".obsidian/app.json")!), { a: 2, b: 2 });
    assert.deepEqual(JSON.parse(alt.vault.hiddenText(".obsidian/app.json")!), { a: 2, b: 2 });
    // die Sicherungen des neuen Geräts tauchen nirgends auf
    assert.ok(![...drive.files.values()].some((f) => f.path.includes("sync-history")));
  });
}

for (const [v, Engine] of versions.slice(0, 2)) {
  test(`${v} (kennt keinen Einstellungs-Sync) ↔ aktuell mit Einstellungs-Sync: Stopp schützt die Plugins, „Behalten“ stellt Drive wieder her`, async () => {
    const drive = new FakeDrive();
    const neu = device(drive, "Neu", true), alt = legacy(Engine, drive, "Alt");
    neu.vault.set("n.md", buf("Notiz"));
    for (let i = 0; i < 4; i++) for (const f of ["main.js", "manifest.json", "styles.css"]) {
      neu.vault.setHidden(`.obsidian/plugins/p${i}/${f}`, `${f} ${i}`);
    }
    await neu.sync();
    await alt.sync(); // lädt fremde Einstellungsdateien herunter (Fehlverhalten der alten Version)
    await alt.sync(); // … und löscht sie in Google Drive
    assert.equal([...drive.files.values()].filter((f) => f.trashed).length, 12, "bekanntes Fehlverhalten von ≤ 1.2.0");
    const err = await neu.sync().then(() => null, (e) => e);
    assert.ok(err instanceof MassDeleteError && err.config, "Sicherheitsstopp für Einstellungsdateien");
    const plugins = () => [...neu.vault.hidden.keys()].filter((k) => /^\.obsidian\/plugins\/p\d\//.test(k)).length;
    assert.equal(plugins(), 12, "nichts gelöscht");
    // altes Gerät wird aktualisiert (nimmt nicht mehr teil), hier „Behalten und wiederherstellen“
    await neu.engine.keepInsteadOfDelete(err.paths);
    const r = await neu.sync(true);
    assert.deepEqual([r.uploaded, r.deleted], [12, 0]);
    assert.equal(plugins(), 12);
    assert.equal([...drive.files.values()].filter((f) => !f.trashed && f.path.startsWith(".obsidian/")).length, 12);
  });

  test(`${v} ↔ aktuell: unter der Stopp-Schwelle werden Einstellungsdateien gelöscht, aber vorher gesichert`, async () => {
    const drive = new FakeDrive();
    const neu = device(drive, "Neu", true), alt = legacy(Engine, drive, "Alt");
    for (const f of ["main.js", "manifest.json", "styles.css"]) neu.vault.setHidden(`.obsidian/plugins/p/${f}`, f);
    await neu.sync(); await alt.sync(); await alt.sync();
    const r = await neu.sync();
    assert.equal(r.deleted, 3, "bekannte Grenze: 3 Dateien sehen aus wie eine normale Deinstallation");
    const backups = (await neu.engine.backups.list()).map((e) => e.original).sort();
    assert.deepEqual(backups, [".obsidian/plugins/p/main.js", ".obsidian/plugins/p/manifest.json", ".obsidian/plugins/p/styles.css"]);
  });
}
