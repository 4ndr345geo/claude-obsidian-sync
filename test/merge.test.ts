import { test } from "node:test";
import assert from "node:assert/strict";
import { hasConflictMarkers, mergeText } from "../src/merge";

const L = { label: "Laptop", time: 2000 };
const H = { label: "Handy", time: 1000 }; // older

test("unkritisch: verschiedene Stellen werden kombiniert", () => {
  const m = mergeText("A1\nB\nC", "A\nB\nC", "A\nB\nC1", L, H);
  assert.deepEqual(m, { clean: true, conflicts: 0, text: "A1\nB\nC1" });
});

test("unkritisch: identische Änderung auf beiden Geräten", () => {
  const m = mergeText("A\nX\nC\nneu", "A\nB\nC", "A\nX\nC", L, H);
  assert.equal(m.clean, true);
  assert.equal(m.text, "A\nX\nC\nneu");
});

test("unkritisch: Zeile hier gelöscht, dort woanders ergänzt", () => {
  const m = mergeText("A\nC", "A\nB\nC", "A\nB\nC\nD", L, H);
  assert.equal(m.text, "A\nC\nD");
});

test("kritisch: Callout mit beiden Versionen, neuere zuerst", () => {
  const m = mergeText("Titel\nLaptop sagt X\nEnde", "Titel\nOriginal\nEnde", "Titel\nHandy sagt Y\nEnde", L, H);
  assert.equal(m.clean, false);
  assert.equal(m.conflicts, 1);
  const lines = m.text.split("\n");
  assert.equal(lines[0], "Titel");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "> [!warning] Sync-Konflikt");
  assert.ok(m.text.indexOf("Laptop sagt X") < m.text.indexOf("Handy sagt Y"));
  assert.match(m.text, /\*\*Laptop · \d\d\.\d\d\.\d{4} \d\d:\d\d\*\*/);
  assert.ok(m.text.endsWith(">\n> Handy sagt Y\n\nEnde"), "Leerzeile beendet den Callout");
  assert.ok(hasConflictMarkers(m.text));
});

test("kritisch: hier gelöscht, dort geändert -> markiert", () => {
  const m = mergeText("A\nC", "A\nB\nC", "A\nB geändert\nC", L, H);
  assert.equal(m.clean, false);
  assert.match(m.text, /an dieser Stelle gelöscht/);
  assert.match(m.text, /> B geändert/);
});

test("kritisch im Codeblock: Textmarker statt Callout", () => {
  const base = "```js\nconst a = 1;\n```\nText";
  const m = mergeText("```js\nconst a = 2;\n```\nText", base, "```js\nconst a = 3;\n```\nText", L, H);
  assert.equal(m.clean, false);
  assert.ok(!m.text.includes("[!warning]"));
  assert.match(m.text, /^```js\n<<<<<<< Sync-Konflikt Laptop .*\nconst a = 2;\n=======\nconst a = 3;\n>>>>>>> Handy .*\n```\nText$/);
});

test("kritisch im Frontmatter: YAML bleibt gültig, Hinweis darunter", () => {
  const base = "---\ntags: a\nstatus: offen\n---\nInhalt";
  const m = mergeText(
    "---\ntags: a\nstatus: fertig\n---\nInhalt",
    base,
    "---\ntags: a\nstatus: wartet\n---\nInhalt neu",
    L,
    H
  );
  assert.equal(m.conflicts, 1);
  const [fm, rest] = [m.text.slice(0, m.text.indexOf("\n---\n") + 5), m.text.slice(m.text.indexOf("\n---\n") + 5)];
  assert.equal(fm, "---\ntags: a\nstatus: fertig\n---\n", "neuere Version im Frontmatter");
  assert.match(rest, /^\n> \[!warning\] Sync-Konflikt\n> In den Eigenschaften/);
  assert.match(rest, /> status: wartet/);
  assert.ok(rest.endsWith("\n\nInhalt neu"), "unkritische Änderung im Text übernommen");
});

test("ohne Basis: gemeinsame Zeilen bleiben, Ergänzungen beider Seiten bleiben", () => {
  const m = mergeText("# Tag\nLaptop\nGemeinsam", null, "# Tag\nGemeinsam\nHandy", L, H);
  assert.equal(m.clean, true);
  assert.equal(m.text, "# Tag\nLaptop\nGemeinsam\nHandy");
});

test("Windows-Zeilenenden werden vereinheitlicht", () => {
  const m = mergeText("A1\r\nB\r\nC", "A\nB\nC", "A\nB\nC1", L, H);
  assert.equal(m.text, "A1\nB\nC1");
});
