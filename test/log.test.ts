import { test } from "node:test";
import assert from "node:assert/strict";
import { addEntry, formatEntry, logPath, makeLogMatcher } from "../src/log";
import type { SyncResult } from "../src/sync";
import { FakeDrive, buf, device } from "./fakes";

const isLog = makeLogMatcher("Sync-Protokoll");
const result = (events: SyncResult["events"], extra: Partial<SyncResult> = {}): SyncResult => ({
  uploaded: 0, downloaded: 0, deleted: 0, merged: 0, marked: [], conflicts: [], errors: [],
  configChanged: false, events, ...extra,
});

test("kein Eintrag, wenn nichts passiert ist oder nur Protokolle übertragen wurden", () => {
  assert.equal(formatEntry(new Date(), 100, result([]), null, isLog), null);
  assert.equal(formatEntry(new Date(), 100, result([{ kind: "down", path: "Sync-Protokoll/iPad.md" }]), null, isLog), null);
});

test("Eintrag: Zusammenfassung, Fehler und Konflikte zuerst, Links zu Notizen", () => {
  const e = formatEntry(new Date(2026, 10, 5, 14, 3, 12), 2100, result([
    { kind: "up", path: "Projekte/Idee.md" },
    { kind: "marked", path: "Einkauf.md" },
    { kind: "error", path: "bild.png", detail: "Google Drive Fehler 403" },
    { kind: "down", path: ".obsidian/app.json" },
  ]), null, isLog)!;
  const lines = e.split("\n");
  assert.equal(lines[0], "## 05.11.2026 14:03:12 · ❌ 2,1 s");
  assert.equal(lines[1], "- ↑ 1 · ↓ 1 · ⚠ 1 · ❌ 1");
  assert.equal(lines[2], "- ❌ Fehler: `bild.png` – `Google Drive Fehler 403`");
  assert.equal(lines[3], "- ⚠ Konflikt in der Notiz markiert: [[Einkauf]]");
  assert.ok(e.includes("↓ heruntergeladen: `.obsidian/app.json`"));
  assert.ok(e.includes("↑ hochgeladen: [[Projekte/Idee]]"));
});

test("Abbruch wird protokolliert", () => {
  const e = formatEntry(new Date(), 50, null, "Anmeldung bei Google fehlgeschlagen (400)", isLog)!;
  assert.match(e, /❌ Synchronisierung abgebrochen: `Anmeldung bei Google fehlgeschlagen/);
});

test("neueste Einträge oben, alte werden entfernt", () => {
  let text = "";
  for (let i = 1; i <= 300; i++) text = addEntry(text, `## Eintrag ${i}\n- ↑ 1`, "iPad", 100);
  const entries = text.match(/^## Eintrag \d+$/gm)!;
  assert.equal(entries[0], "## Eintrag 300");
  assert.ok(text.split("\n").length <= 110);
  assert.equal(text.match(/^# Sync-Protokoll – iPad$/gm)!.length, 1, "Kopfzeile nur einmal");
});

test("Dateiname aus Gerätenamen", () => {
  assert.equal(logPath("Sync-Protokoll/", "Andreas' iPad: Pro"), "Sync-Protokoll/Andreas' iPad Pro.md");
});

test("zwei Geräte mit Protokoll schaukeln sich nicht gegenseitig auf", async () => {
  const drive = new FakeDrive();
  const devs = [device(drive, "Laptop"), device(drive, "iPad")];
  let writes = 0;
  // Same as the plugin: write the own log after every sync, if there is something to log.
  const syncAndLog = async (d: (typeof devs)[number]) => {
    const r = await d.sync();
    const entry = formatEntry(new Date(), 10, r, null, isLog);
    if (!entry) return;
    writes++;
    const p = logPath("Sync-Protokoll", d.name);
    d.vault.set(p, buf(addEntry(d.vault.text(p) ?? "", entry, d.name)));
  };
  devs[0].vault.set("Notiz.md", buf("Hallo"));
  for (let round = 0; round < 6; round++) for (const d of devs) await syncAndLog(d);
  assert.equal(writes, 2, "genau ein Eintrag pro Gerät (Laptop: ↑, iPad: ↓)");
  for (const d of devs) {
    assert.ok(d.vault.text("Sync-Protokoll/Laptop.md")?.includes("↑ hochgeladen: [[Notiz]]"), d.name);
    assert.ok(d.vault.text("Sync-Protokoll/iPad.md")?.includes("↓ heruntergeladen: [[Notiz]]"), d.name);
  }
});
