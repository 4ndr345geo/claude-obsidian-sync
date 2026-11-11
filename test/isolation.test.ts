import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveError } from "../src/drive";
import { delayFor, FailureTracker, fingerprint } from "../src/isolation";
import { FakeDrive, buf, device } from "./fakes";

function setup() {
  const drive = new FakeDrive();
  return { drive, a: device(drive, "Laptop"), b: device(drive, "Handy") };
}

test("Wartezeiten wachsen; dauerhafte Fehler warten sofort lange", () => {
  const min = 60_000;
  assert.deepEqual([1, 2, 3, 4, 9].map((n) => delayFor(n, "other") / min), [1, 10, 60, 360, 360]);
  assert.equal(delayFor(1, "tooLarge") / min, 360);
  assert.equal(delayFor(1, "forbidden") / min, 360);
});

test("Zurückstellen: Wartezeit, Änderung und manueller Lauf", () => {
  const failures = {};
  const fp = fingerprint({ mtime: 1, size: 2 }, ["x"]);
  new FailureTracker(failures, false, 1000).fail("a.md", "kaputt", "other", fp);
  assert.ok(new FailureTracker(failures, false, 1000 + 30_000).isHeld("a.md", fp), "innerhalb der Wartezeit");
  assert.ok(!new FailureTracker(failures, false, 1000 + 61_000).isHeld("a.md", fp), "Wartezeit vorbei");
  assert.ok(!new FailureTracker(failures, false, 1000).isHeld("a.md", fingerprint({ mtime: 5, size: 2 }, ["x"])), "lokal geändert");
  assert.ok(!new FailureTracker(failures, false, 1000).isHeld("a.md", fingerprint({ mtime: 1, size: 2 }, ["y"])), "in Drive geändert");
  assert.ok(!new FailureTracker(failures, true, 1000).isHeld("a.md", fp), "manuell");
  const t = new FailureTracker(failures, false, 2000);
  assert.equal(t.fail("a.md", "kaputt", "other", fp), false, "gleicher Fehler wird nicht erneut gemeldet");
  assert.equal(t.fail("a.md", "anders", "other", fp), true);
  assert.ok(t.failed.has("a.md"), "auch ein nicht gemeldeter Fehler zählt als Fehlschlag");
  assert.equal((failures as Record<string, { count: number }>)["a.md"].count, 3);
});

test("Nicht lesbare Notiz: alle anderen werden synchronisiert, sie selbst gilt nicht als gelöscht", async () => {
  const { drive, a, b } = setup();
  a.vault.set("gut.md", buf("gut"));
  a.vault.set("gesperrt.md", buf("v1"));
  await a.sync(); await b.sync();
  a.vault.set("gesperrt.md", buf("v2 lokal"));
  a.vault.unreadable.add("gesperrt.md");
  a.vault.set("neu.md", buf("neu"));
  b.vault.set("gut.md", buf("gut von b"));
  await b.sync();
  const r = await a.sync();
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /gesperrt\.md: Datei kann nicht gelesen werden/);
  assert.equal(r.uploaded, 1, "neu.md");
  assert.equal(a.vault.text("gut.md"), "gut von b", "Download der anderen Datei läuft weiter");
  assert.equal(a.vault.text("gesperrt.md"), "v2 lokal", "nicht überschrieben");
  assert.equal([...drive.files.values()].filter((f) => f.trashed).length, 0, "in Drive nicht gelöscht");
  assert.ok(a.state.base["gesperrt.md"], "Basis bleibt erhalten");
  // automatischer Lauf: zurückgestellt, kein erneuter Leseversuch, keine Meldung
  const r2 = await a.sync();
  assert.deepEqual([r2.errors.length, r2.held], [0, 1]);
  // wieder lesbar -> manueller Lauf überträgt die lokale Änderung
  a.vault.unreadable.delete("gesperrt.md");
  const r3 = await a.sync(false, true);
  assert.deepEqual([r3.uploaded, r3.held, r3.errors.length], [1, 0, 0]);
  assert.deepEqual(a.state.failures, {});
  await b.sync();
  assert.equal(b.vault.text("gesperrt.md"), "v2 lokal");
});

test("Datei lässt sich lokal nicht schreiben: Rest läuft, Datei wird nach Änderung in Drive sofort erneut versucht", async () => {
  const { a, b } = setup();
  b.vault.set("x.md", buf("x1"));
  b.vault.set("y.md", buf("y1"));
  a.vault.unwritable.add("x.md");
  await b.sync();
  const r = await a.sync();
  assert.deepEqual([r.downloaded, r.errors.length], [1, 1]);
  assert.equal(a.vault.text("y.md"), "y1");
  assert.equal(a.state.failures!["x.md"].count, 1);
  assert.equal((await a.sync()).held, 1);
  a.vault.unwritable.delete("x.md");
  b.vault.set("x.md", buf("x2"));
  await b.sync();
  const r2 = await a.sync(); // automatisch, aber Drive-Version hat sich geändert
  assert.deepEqual([r2.held, r2.downloaded], [0, 1]);
  assert.equal(a.vault.text("x.md"), "x2");
  assert.deepEqual(a.state.failures, {});
});

test("Datei zu groß: wird lange zurückgestellt, die übrigen laufen weiter", async () => {
  const { drive, a } = setup();
  for (const p of ["a.md", "riesig.mp4", "c.md"]) a.vault.set(p, buf(p));
  const real = drive.upload.bind(drive);
  drive.upload = async (...args: Parameters<typeof real>) => {
    if (args[1] === "riesig.mp4") throw new DriveError("zu groß", 413, "tooLarge", "file");
    return real(...args);
  };
  const r = await a.sync();
  assert.deepEqual([r.uploaded, r.errors.length], [2, 1]);
  const f = a.state.failures!["riesig.mp4"];
  assert.equal(f.kind, "tooLarge");
  assert.ok(f.nextTry - Date.now() > 5 * 3600_000);
  assert.equal((await a.sync()).held, 1);
});

test("Nicht lesbarer Plugin-Ordner in .obsidian: nur dieser Ordner wird zurückgestellt", async () => {
  const drive = new FakeDrive();
  const a = device(drive, "Laptop", true), b = device(drive, "Handy", true);
  a.vault.setHidden(".obsidian/app.json", '{"a":1}');
  a.vault.setHidden(".obsidian/plugins/dataview/data.json", '{"x":1}');
  a.vault.setHidden(".obsidian/plugins/dataview/main.js", "code");
  await a.sync(); await b.sync();
  a.vault.unreadable.add(".obsidian/plugins/dataview");
  a.vault.setHidden(".obsidian/app.json", '{"a":2}');
  const r = await a.sync();
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /\.obsidian\/plugins\/dataview: Ordner kann nicht gelesen werden/);
  assert.equal(r.uploaded, 1, "app.json");
  assert.equal(r.deleted, 0, "Plugin-Dateien gelten nicht als gelöscht");
  assert.equal([...drive.files.values()].filter((f) => f.trashed).length, 0);
  assert.equal((await a.sync()).held, 2);
  a.vault.unreadable.delete(".obsidian/plugins/dataview");
  const r3 = await a.sync(false, true);
  assert.deepEqual([r3.errors.length, r3.held, r3.deleted], [0, 0, 0]);
  assert.deepEqual(a.state.failures, {});
});

test("Datensatz eines Fehlers verschwindet, wenn die Datei überall gelöscht ist", async () => {
  const { a } = setup();
  a.vault.set("weg.md", buf("x"));
  a.vault.unreadable.add("weg.md");
  await a.sync();
  assert.ok(a.state.failures!["weg.md"]);
  a.vault.remove("weg.md");
  await a.sync();
  assert.deepEqual(a.state.failures, {});
});
