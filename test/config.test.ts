import { test } from "node:test";
import assert from "node:assert/strict";
import { makeConfigFilter } from "../src/config";
import { mergeJson } from "../src/merge";
import { FakeDrive, device } from "./fakes";

const all = { enabled: true, settings: true, appearance: true, plugins: true };

test("Filter: was aus .obsidian synchronisiert wird", () => {
  const f = makeConfigFilter(".obsidian", "gdrive-vault-sync", all);
  for (const p of [".obsidian/app.json", ".obsidian/hotkeys.json", ".obsidian/community-plugins.json",
    ".obsidian/themes/Minimal/theme.css", ".obsidian/snippets/meins.css",
    ".obsidian/plugins/dataview/main.js", ".obsidian/plugins/dataview/data.json"]) assert.ok(f(p), p);
  for (const p of [".obsidian/workspace.json", ".obsidian/workspace-mobile.json",
    ".obsidian/plugins/gdrive-vault-sync/data.json", ".obsidian/plugins/gdrive-vault-sync/base/x.txt",
    ".obsidian/plugins/obsidian-git/.git/config", ".obsidian/plugins/x/node_modules/a.js",
    "Notiz.md", ".obsidian/irgendwas.txt"]) assert.ok(!f(p), p);
  const off = makeConfigFilter(".obsidian", "gdrive-vault-sync", { ...all, enabled: false });
  assert.ok(!off(".obsidian/app.json"));
  const noPlugins = makeConfigFilter(".obsidian", "gdrive-vault-sync", { ...all, plugins: false });
  assert.ok(!noPlugins(".obsidian/plugins/dataview/main.js"));
  assert.ok(!noPlugins(".obsidian/community-plugins.json"));
  assert.ok(noPlugins(".obsidian/app.json"));
});

test("JSON: verschiedene Einstellungen werden zusammengeführt", () => {
  const base = JSON.stringify({ theme: "obsidian", fontSize: 16, editor: { spellcheck: false, vim: false } });
  const local = JSON.stringify({ theme: "moonstone", fontSize: 16, editor: { spellcheck: false, vim: false } });
  const remote = JSON.stringify({ theme: "obsidian", fontSize: 18, editor: { spellcheck: true, vim: false }, neu: 1 });
  assert.deepEqual(JSON.parse(mergeJson(local, base, remote, false)!),
    { theme: "moonstone", fontSize: 18, editor: { spellcheck: true, vim: false }, neu: 1 });
});

test("JSON: gleiche Einstellung unterschiedlich -> neuere gewinnt, gelöschte bleibt gelöscht", () => {
  const base = JSON.stringify({ a: 1, b: 2, c: 3 });
  const local = JSON.stringify({ a: 10, c: 3 });
  const remote = JSON.stringify({ a: 20, b: 2, c: 3 });
  assert.deepEqual(JSON.parse(mergeJson(local, base, remote, true)!), { a: 10, c: 3 });
  assert.deepEqual(JSON.parse(mergeJson(local, base, remote, false)!), { a: 20, c: 3 });
});

test("JSON: Listen (z. B. aktive Plugins) gelten als eine Einstellung", () => {
  const m = mergeJson('["a","b"]', '["a"]', '["a","c"]', true);
  assert.deepEqual(JSON.parse(m!), ["a", "b"]);
  assert.equal(mergeJson("kaputt{", null, "{}", true), null);
});

test("Sync: Einstellungen, Themes und Plugins kommen auf dem anderen Gerät an", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop", true), b = device(drive, "iPad", true);
  a.vault.setHidden(".obsidian/app.json", '{"vimMode": true}');
  a.vault.setHidden(".obsidian/snippets/farben.css", "body{}");
  a.vault.setHidden(".obsidian/plugins/dataview/main.js", "code");
  a.vault.setHidden(".obsidian/workspace.json", '{"layout": 1}');
  a.vault.setHidden(".obsidian/plugins/gdrive-vault-sync/data.json", '{"refreshToken": "geheim"}');
  await a.sync();
  const r = await b.sync();
  assert.equal(r.configChanged, true);
  assert.equal(b.vault.hiddenText(".obsidian/app.json"), '{"vimMode": true}');
  assert.equal(b.vault.hiddenText(".obsidian/snippets/farben.css"), "body{}");
  assert.equal(b.vault.hiddenText(".obsidian/plugins/dataview/main.js"), "code");
  const remote = (await drive.listFiles()).map((f) => f.path);
  assert.ok(!remote.includes(".obsidian/workspace.json"), "Layout bleibt lokal");
  assert.ok(!remote.some((p) => p.includes("gdrive-vault-sync")), "Zugang/Status dieses Plugins bleibt lokal");
  assert.equal((await a.sync()).configChanged, false, "keine Endlosschleife");
});

test("Sync: Einstellungen auf zwei Geräten geändert -> beide Änderungen bleiben", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop", true), b = device(drive, "iPad", true);
  a.vault.setHidden(".obsidian/app.json", JSON.stringify({ vimMode: false, spellcheck: false }, null, 2));
  await a.sync(); await b.sync();
  a.vault.setHidden(".obsidian/app.json", JSON.stringify({ vimMode: true, spellcheck: false }, null, 2));
  b.vault.setHidden(".obsidian/app.json", JSON.stringify({ vimMode: false, spellcheck: true }, null, 2));
  await a.sync(); await b.sync(); await a.sync();
  for (const d of [a, b]) {
    assert.deepEqual(JSON.parse(d.vault.hiddenText(".obsidian/app.json")!), { vimMode: true, spellcheck: true }, d.name);
  }
  const copies = [...a.vault.hidden.keys(), ...b.vault.hidden.keys()].filter((k) => k.includes("Konflikt"));
  assert.deepEqual(copies, [], "keine Konfliktkopien in .obsidian");
});

test("Sync: deinstalliertes Plugin wird auf den anderen Geräten entfernt", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop", true), b = device(drive, "iPad", true);
  a.vault.setHidden(".obsidian/plugins/alt/main.js", "x");
  a.vault.setHidden(".obsidian/plugins/alt/manifest.json", "{}");
  await a.sync(); await b.sync();
  a.vault.hidden.delete(".obsidian/plugins/alt/main.js");
  a.vault.hidden.delete(".obsidian/plugins/alt/manifest.json");
  await a.sync(); await b.sync();
  assert.ok(![...b.vault.hidden.keys()].some((k) => k.includes("plugins/alt")));
});

test("Sync: Gerät ohne Einstellungs-Sync ignoriert fremde Einstellungen und löscht nichts", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop", true), b = device(drive, "Handy", false);
  a.vault.setHidden(".obsidian/app.json", '{"x": 1}');
  b.vault.setHidden(".obsidian/app.json", '{"x": 2}');
  await a.sync(); await b.sync(); await a.sync();
  assert.equal(b.vault.hiddenText(".obsidian/app.json"), '{"x": 2}');
  assert.equal(a.vault.hiddenText(".obsidian/app.json"), '{"x": 1}');
  assert.equal((await drive.listFiles()).length, 1);
});

test("Sync: Ausschalten löscht nichts", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop", true), b = device(drive, "iPad", true);
  a.vault.setHidden(".obsidian/app.json", '{"x": 1}');
  await a.sync(); await b.sync();
  b.config.enabled = false;
  await b.sync(); await a.sync();
  assert.equal(a.vault.hiddenText(".obsidian/app.json"), '{"x": 1}');
  assert.equal(b.vault.hiddenText(".obsidian/app.json"), '{"x": 1}');
  assert.equal((await drive.listFiles()).length, 1);
});
