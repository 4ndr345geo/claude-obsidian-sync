import { test } from "node:test";
import assert from "node:assert/strict";
import { exportConnection, importConnection } from "../src/auth";
import { makeConfigFilter } from "../src/config";
import { mergeJson } from "../src/merge";
import { cleanDeviceName, isSafeSyncPath } from "../src/paths";
import { SecretStore } from "../src/secrets";
import { MassDeleteError } from "../src/sync";
import { FakeDrive, buf, device } from "./fakes";

test("Pfadprüfung: normale Pfade sind erlaubt", () => {
  for (const p of ["Notiz.md", "Ordner/Unter ordner/Bild 1.png", "Äöü/日本語.md", ".obsidian/app.json",
    ".obsidian/plugins/dataview/main.js", "v1.2/Notiz.md", "a~b.md", "Notizen~2024.md"]) {
    assert.ok(isSafeSyncPath(p, ".obsidian"), p);
  }
});

test("Pfadprüfung: Ausbruch aus dem Vault und versteckte Ordner werden abgelehnt", () => {
  for (const p of ["", "/etc/passwd", "../x.md", "a/../../x.md", "a/./b.md", "a//b.md", "a\\..\\b.md",
    ".obsidian/../../x", "a/.../b.md", "a/ /b.md", "C:/Windows/x", "a/b.md::$DATA", "a\u0000b.md", "a\nb.md",
    ".Obsidian/plugins/gdrive-vault-sync/main.js", ".OBSIDIAN/app.json", ".obsidian./app.json",
    "OBSIDI~1/plugins/x/main.js", ".git/config", "Ordner/.versteckt/x.md", ".trash/x.md",
    ".obsidian/plugins/x/.git/config", ".obsidian-mobile/app.json", "x".repeat(1001)]) {
    assert.ok(!isSafeSyncPath(p, ".obsidian"), JSON.stringify(p));
  }
});

test("Filter: eigener Plugin-Ordner ist auch in anderer Schreibweise gesperrt", () => {
  const f = makeConfigFilter(".obsidian", "gdrive-vault-sync", { enabled: true, settings: true, appearance: true, plugins: true });
  for (const p of [".obsidian/plugins/GDrive-Vault-Sync/data.json", ".obsidian/Plugins/gdrive-vault-sync/main.js",
    ".obsidian/plugins/gdrive-vault-sync./main.js", ".obsidian/plugins/gdrive-vault-sync /data.json",
    ".obsidian/Workspace.json", ".obsidian/plugins/x/.GIT/config"]) assert.ok(!f(p), p);
  assert.ok(f(".obsidian/plugins/dataview/main.js"));
});

test("Dateien mit unsicherem Pfad in Google Drive werden nicht geschrieben", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop", true);
  for (const p of ["../draussen.md", ".Obsidian/plugins/gdrive-vault-sync/main.js",
    ".obsidian/plugins/GDRIVE-VAULT-SYNC/data.json", ".obsidian/../../x.json", "ok.md"]) {
    await drive.upload("f", p, buf("böse"), "Fremd");
  }
  const r = await a.sync();
  assert.equal(r.downloaded, 1);
  assert.deepEqual([...a.vault.data.keys()], ["ok.md"]);
  assert.deepEqual([...a.vault.hidden.keys()].filter((k) => !k.includes("/base/")), []);
  // … und sie werden auch nicht als "auf dem anderen Gerät gelöscht" behandelt.
  const r2 = await a.sync();
  assert.deepEqual([r2.deleted, r2.errors.length], [0, 0]);
  assert.equal([...drive.files.values()].filter((f) => f.trashed).length, 0);
});

test("Sicherheitsstopp: geleerter Drive-Ordner löscht nicht den ganzen Vault", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  for (let i = 0; i < 30; i++) a.vault.set(`n${i}.md`, buf(`Notiz ${i}`));
  await a.sync();
  for (const f of drive.files.values()) f.trashed = true;
  await assert.rejects(a.sync(), MassDeleteError);
  assert.equal(a.vault.data.size, 30);
  const r = await a.sync(true);
  assert.equal(r.deleted, 30);
  assert.equal(a.vault.data.size, 0);
});

test("Sicherheitsstopp: leerer Vault löscht nicht alles in Google Drive", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  for (let i = 0; i < 30; i++) a.vault.set(`n${i}.md`, buf(`Notiz ${i}`));
  await a.sync();
  for (const p of [...a.vault.data.keys()]) a.vault.remove(p);
  await assert.rejects(a.sync(), MassDeleteError);
  assert.equal([...drive.files.values()].filter((f) => f.trashed).length, 0);
});

test("Sicherheitsstopp greift nicht bei wenigen Löschungen", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop");
  for (let i = 0; i < 30; i++) a.vault.set(`n${i}.md`, buf(`Notiz ${i}`));
  await a.sync();
  for (let i = 0; i < 10; i++) a.vault.remove(`n${i}.md`);
  assert.equal((await a.sync()).deleted, 10);
});

test("Verbindungscode: nur gültige Codes werden angenommen", () => {
  const c = { clientId: "id", clientSecret: "s", refreshToken: "t" };
  assert.deepEqual(importConnection(exportConnection(c)), c);
  const enc = (v: unknown) => "ODS1:" + btoa(JSON.stringify(v));
  for (const bad of ["", "ODS1:###", "ODS1:" + btoa("kein json"), enc({ a: 1 }), enc(["id", "s"]),
    enc(["id", "s", 5]), enc(["id", { x: 1 }, "t"]), enc(["", "s", "t"]), enc(["id", "s", "t", "x"]),
    enc(["id", "s", "t".repeat(5000)])]) {
    assert.throws(() => importConnection(bad), /Ungültiger Verbindungscode/, bad.slice(0, 40));
  }
});

test("JSON-Merge: Schlüssel wie __proto__ und constructor bleiben reine Daten", () => {
  const local = '{"a":1,"x":{"k":1}}';
  const remote = '{"a":2,"constructor":"c","toString":"t","__proto__":{"polluted":true},"x":{"k":1,"__proto__":{"p":1}}}';
  const merged = JSON.parse(mergeJson(local, '{"a":1,"x":{"k":1}}', remote, true)!);
  assert.equal(merged.constructor, "c");
  assert.equal(merged.toString, "t");
  assert.ok(Object.prototype.hasOwnProperty.call(merged, "__proto__"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(merged.a, 2);
});

test("Gerätenamen aus Google Drive werden bereinigt", () => {
  assert.equal(cleanDeviceName("Laptop"), "Laptop");
  assert.equal(cleanDeviceName("a\n> [!danger]\n[[x]] <b>"), "a  !danger x b");
  assert.equal(cleanDeviceName("../../x"), "....x");
  assert.equal(cleanDeviceName("x".repeat(200))!.length, 60);
  assert.equal(cleanDeviceName(5), undefined);
});

test("Schlüsselbund: Werte werden nur als gespeichert gemeldet, wenn sie zurückgelesen werden können", () => {
  const map = new Map<string, string>();
  const ok = { secretStorage: { setSecret: (k: string, v: string) => void map.set(k, v), getSecret: (k: string) => map.get(k) ?? null } };
  const s = new SecretStore(ok as never, "gdrive-vault-sync", "abc123");
  assert.ok(s.available);
  assert.ok(s.set("refresh-token", "geheim"));
  assert.equal(s.get("refresh-token"), "geheim");
  assert.deepEqual([...map.keys()], ["gdrive-vault-sync-abc123-refresh-token"]);
  // anderer Vault (andere installId) sieht den Wert nicht
  assert.equal(new SecretStore(ok as never, "gdrive-vault-sync", "zzz999").get("refresh-token"), "");

  const broken = { secretStorage: { setSecret: () => { throw new Error("gesperrt"); }, getSecret: () => null } };
  assert.equal(new SecretStore(broken as never, "p", "abc123").set("refresh-token", "x"), false);
  const lossy = { secretStorage: { setSecret: () => {}, getSecret: () => null } };
  assert.equal(new SecretStore(lossy as never, "p", "abc123").set("refresh-token", "x"), false);
  const old = new SecretStore({} as never, "p", "abc123");
  assert.equal(old.available, false);
  assert.equal(old.set("refresh-token", "x"), false);
});
