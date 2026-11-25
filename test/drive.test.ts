import { test } from "node:test";
import assert from "node:assert/strict";
import SparkMD5 from "spark-md5";
import { scopeUrl, SCOPE_DRIVE, SCOPE_DRIVE_FILE } from "../src/auth";
import { APP_PROPERTY_LIMIT, buildMetadata, DriveClient, truncateUtf8 } from "../src/drive";
import { SyncEngine, SyncState } from "../src/sync";
import { setRequestHandler } from "./obsidian-mock";
import { buf, FakeVault } from "./fakes";

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

test("PATCH in echtem Drive-Unterordner behält nur den Dateinamen (kein doppelter Ordnerpfad)", () => {
  const m = buildMetadata("rootFolder", "Claude/Ideen/Notiz.md", "Laptop", "file1", Date.now(), true);
  assert.equal(m.name, "Notiz.md");
  assert.equal(m.parents, undefined);
});

test("Kürzen zerschneidet keine Umlaute", () => {
  assert.equal(truncateUtf8("ÄÄÄ", 5), "ÄÄ");
  assert.equal(truncateUtf8("kurz", 100), "kurz");
});

test("OAuth-Scope-Helfer liefert drive für Claude/Drive-Web und drive.file für Minimalmodus", () => {
  assert.equal(scopeUrl("drive"), SCOPE_DRIVE);
  assert.equal(scopeUrl("drive.file"), SCOPE_DRIVE_FILE);
  assert.equal(SCOPE_DRIVE, "https://www.googleapis.com/auth/drive");
});

test("DriveClient.listFiles liest verschachtelte Drive-Unterordner rekursiv und überspringt Google Docs", async () => {
  setRequestHandler(((p: { url: string }) => {
    if (p.url.includes("oauth2")) {
      return { status: 200, headers: {}, json: { access_token: "tok", expires_in: 3600, scope: SCOPE_DRIVE } };
    }
    const qParam = new URL(p.url).searchParams.get("q") ?? "";
    if (qParam.includes("'ROOT' in parents")) {
      return {
        status: 200,
        headers: {},
        json: {
          files: [
            { id: "rootNote", name: "root.md", mimeType: "text/markdown", md5Checksum: "aaa", modifiedTime: "2026-11-25T10:00:00Z", size: "5" },
            { id: "subClaude", name: "Claude", mimeType: "application/vnd.google-apps.folder" },
            { id: "gdoc1", name: "Unexportiert", mimeType: "application/vnd.google-apps.document" },
          ],
        },
      };
    }
    if (qParam.includes("'subClaude' in parents")) {
      return {
        status: 200,
        headers: {},
        json: {
          files: [
            { id: "subNested", name: "Entwürfe", mimeType: "application/vnd.google-apps.folder" },
            { id: "claudeNote", name: "Notiz.md", mimeType: "text/markdown", md5Checksum: "bbb", modifiedTime: "2026-11-25T10:01:00Z", size: "12" },
          ],
        },
      };
    }
    if (qParam.includes("'subNested' in parents")) {
      return {
        status: 200,
        headers: {},
        json: {
          files: [
            { id: "deepNote", name: "Idee.md", mimeType: "text/plain", md5Checksum: "ccc", modifiedTime: "2026-11-25T10:02:00Z", size: "8" },
          ],
        },
      };
    }
    return { status: 200, headers: {}, json: { files: [] } };
  }) as never);

  const drive = new DriveClient(() => ({ clientId: "i", clientSecret: "s", refreshToken: "t" }), async () => {});
  const files = await drive.listFiles("ROOT");
  assert.equal(drive.lastTokenScope, "drive");
  assert.deepEqual(
    files.map((f) => [f.id, f.path, !!f.inSubfolder]),
    [
      ["rootNote", "root.md", false],
      ["claudeNote", "Claude/Notiz.md", true],
      ["deepNote", "Claude/Entwürfe/Idee.md", true],
    ]
  );
  assert.deepEqual(drive.getListedFolders("ROOT"), {
    subClaude: { name: "Claude", parentId: "ROOT" },
    subNested: { name: "Entwürfe", parentId: "subClaude" },
  });
});

test("DriveClient.listChanges löst Unterordner-Pfade auf und erkennt neue/geänderte Sync-Unterordner", async () => {
  const folders = {
    subClaude: { name: "Claude", parentId: "ROOT" },
    subNested: { name: "Entwürfe", parentId: "subClaude" },
  };
  let scenario = 1;
  setRequestHandler(((p: { url: string }) => {
    if (p.url.includes("oauth2")) return { status: 200, headers: {}, json: { access_token: "tok", expires_in: 3600 } };
    if (scenario === 1) {
      return {
        status: 200,
        headers: {},
        json: {
          newStartPageToken: "t2",
          changes: [
            // Datei in bekanntem Unterordner (von Claude erstellt/bearbeitet)
            { fileId: "n1", removed: false, file: { id: "n1", name: "Plan.md", mimeType: "text/markdown", md5Checksum: "m1", parents: ["subNested"], trashed: false } },
            // Ordner außerhalb des Vaults darf keinen Full-Reset erzwingen
            { fileId: "otherFolder", removed: false, file: { id: "otherFolder", name: "Steuern", mimeType: "application/vnd.google-apps.folder", parents: ["unrelatedRoot"], trashed: false } },
          ],
        },
      };
    }
    return {
      status: 200,
      headers: {},
      json: {
        newStartPageToken: "t3",
        changes: [
          // Neuer Unterordner direkt im Sync-Ordner -> Reset auf volle rekursive Liste
          { fileId: "newSub", removed: false, file: { id: "newSub", name: "Neu", mimeType: "application/vnd.google-apps.folder", parents: ["ROOT"], trashed: false } },
        ],
      },
    };
  }) as never);

  const drive = new DriveClient(() => ({ clientId: "i", clientSecret: "s", refreshToken: "t" }), async () => {});
  const r1 = await drive.listChanges("t1", "ROOT", folders);
  assert.equal(r1.reset, undefined);
  assert.equal(r1.changed.length, 1);
  assert.equal(r1.changed[0].path, "Claude/Entwürfe/Plan.md");
  assert.equal(r1.changed[0].inSubfolder, true);

  scenario = 2;
  const r2 = await drive.listChanges("t2", "ROOT", folders);
  assert.equal(r2.reset, true);
  assert.equal(r2.token, "t3");
});

test("End-to-End: von Claude in Drive-Unterordner erstellte .md synchronisiert herunter und PATCH erhält Unterordnernamen", async () => {
  const initialContent = "# Von Claude\nHallo Obsidian";
  const initialBuf = buf(initialContent);
  let remoteMd = {
    id: "claudeFile1",
    name: "Notiz.md",
    mimeType: "text/markdown",
    content: initialBuf,
    md5: SparkMD5.ArrayBuffer.hash(initialBuf),
    modifiedTime: "2026-11-25T11:00:00.000Z",
    parents: ["subClaude"],
  };
  let lastPatchMetadata: Record<string, unknown> | null = null;

  setRequestHandler((async (p: { url: string; method?: string; body?: ArrayBuffer | string }) => {
    if (p.url.includes("oauth2")) {
      return { status: 200, headers: {}, json: { access_token: "tok", expires_in: 3600, scope: SCOPE_DRIVE } };
    }
    if (p.url.includes("/files/ROOT?")) {
      return { status: 200, headers: {}, json: { id: "ROOT", trashed: false, mimeType: "application/vnd.google-apps.folder" } };
    }
    if (p.url.includes("/changes/startPageToken")) {
      return { status: 200, headers: {}, json: { startPageToken: "tok1" } };
    }
    if (p.url.includes("/drive/v3/files?")) {
      const qParam = new URL(p.url).searchParams.get("q") ?? "";
      if (qParam.includes("'ROOT' in parents")) {
        return { status: 200, headers: {}, json: { files: [{ id: "subClaude", name: "Claude", mimeType: "application/vnd.google-apps.folder" }] } };
      }
      if (qParam.includes("'subClaude' in parents")) {
        return {
          status: 200,
          headers: {},
          json: {
            files: [{
              id: remoteMd.id,
              name: remoteMd.name,
              mimeType: remoteMd.mimeType,
              md5Checksum: remoteMd.md5,
              modifiedTime: remoteMd.modifiedTime,
              size: String(remoteMd.content.byteLength),
            }],
          },
        };
      }
      return { status: 200, headers: {}, json: { files: [] } };
    }
    if (p.url.includes(`/files/${remoteMd.id}?alt=media`)) {
      return { status: 200, headers: {}, arrayBuffer: remoteMd.content.slice(0) };
    }
    if (p.url.includes(`/files/${remoteMd.id}?fields=`)) {
      return {
        status: 200,
        headers: {},
        json: {
          id: remoteMd.id,
          name: remoteMd.name,
          mimeType: remoteMd.mimeType,
          md5Checksum: remoteMd.md5,
          modifiedTime: remoteMd.modifiedTime,
          trashed: false,
        },
      };
    }
    if (p.method === "PATCH" && p.url.includes(`/upload/drive/v3/files/${remoteMd.id}`)) {
      const raw = new TextDecoder().decode(p.body as ArrayBuffer);
      const jsonMatch = raw.match(/Content-Type: application\/json[^\r\n]*\r\n\r\n([^\r\n]+)/);
      lastPatchMetadata = jsonMatch ? JSON.parse(jsonMatch[1]) : null;
      const bodyStart = raw.indexOf("application/octet-stream\r\n\r\n") + "application/octet-stream\r\n\r\n".length;
      const bodyEnd = raw.lastIndexOf("\r\n--obsidian-drive-sync-");
      const updatedStr = raw.slice(bodyStart, bodyEnd);
      const updatedBuf = buf(updatedStr);
      remoteMd = {
        ...remoteMd,
        name: String(lastPatchMetadata?.name ?? remoteMd.name),
        content: updatedBuf,
        md5: SparkMD5.ArrayBuffer.hash(updatedBuf),
      };
      return {
        status: 200,
        headers: {},
        json: {
          id: remoteMd.id,
          name: remoteMd.name,
          mimeType: remoteMd.mimeType,
          md5Checksum: remoteMd.md5,
          modifiedTime: remoteMd.modifiedTime,
        },
      };
    }
    return { status: 200, headers: {}, json: {} };
  }) as never);

  const vault = new FakeVault();
  const drive = new DriveClient(() => ({ clientId: "i", clientSecret: "s", refreshToken: "t" }), async () => {});
  const state: SyncState = { base: {}, cache: {}, folderId: "ROOT", folderName: "Obsidian – Test" };
  const app = { vault, fileManager: { trashFile: async (f: { path: string }) => vault.remove(f.path) } };
  const engine = new SyncEngine(
    app as never,
    drive,
    state,
    () => ({
      folderName: "Obsidian – Test",
      deviceName: "Laptop",
      excludes: [],
      config: { enabled: false, settings: true, appearance: true, plugins: true },
      backup: { enabled: false, keepDays: 30, maxTotalBytes: 1e7, maxFileBytes: 1e6 },
    }),
    ".obsidian/plugins/gdrive-vault-sync/base",
    async () => {}
  );

  // 1) Erste Synchronisierung holt Claude/Notiz.md in Obsidian
  const r1 = await engine.run(undefined, false, true);
  assert.equal(r1.downloaded, 1);
  assert.equal(vault.text("Claude/Notiz.md"), initialContent);

  // 2) Änderung in Obsidian lädt per PATCH mit Basisnamen "Notiz.md" hoch (nicht "Claude/Notiz.md")
  vault.set("Claude/Notiz.md", buf("# Von Claude\nErgänzt in Obsidian"));
  const r2 = await engine.run(undefined, false, true);
  assert.equal(r2.uploaded, 1);
  assert.equal(lastPatchMetadata?.name, "Notiz.md");
  assert.equal(remoteMd.name, "Notiz.md");
});
