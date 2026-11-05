import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_PROPERTY_LIMIT, buildMetadata, truncateUtf8 } from "../src/drive";

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

test("lange Pfade mit Umlauten überschreiten nie das 124-Byte-Limit von Google Drive", () => {
  const path = "Projekte/Größere Überlegungen zur Gemüsezüchtung/" + "Ä".repeat(200) + "/Notiz über Äpfel.md";
  const device = "Andreas' sehr langer Gerätename ".repeat(10);
  for (const id of [undefined, "abc"]) {
    const m = buildMetadata("folder", path, device, id, Date.now());
    assert.equal(m.name, path, "voller Pfad bleibt im Dateinamen erhalten");
    for (const [k, v] of Object.entries(m.appProperties as Record<string, string | null>)) {
      assert.ok(bytes(k) + bytes(v ?? "") <= APP_PROPERTY_LIMIT, `${k} zu lang`);
    }
  }
});

test("alte vpath-Eigenschaft wird beim Aktualisieren entfernt", () => {
  const m = buildMetadata("folder", "a.md", "Laptop", "id1");
  assert.equal((m.appProperties as Record<string, unknown>).vpath, null);
  assert.equal(m.parents, undefined);
  assert.deepEqual(buildMetadata("folder", "a.md", "Laptop").parents, ["folder"]);
});

test("Kürzen zerschneidet keine Umlaute", () => {
  assert.equal(truncateUtf8("ÄÄÄ", 5), "ÄÄ");
  assert.equal(truncateUtf8("kurz", 100), "kurz");
});
