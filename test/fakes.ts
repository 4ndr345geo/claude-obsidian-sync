import SparkMD5 from "spark-md5";
import { TFile, TFolder } from "obsidian";
import type { RemoteEntry } from "../src/plan";
import { SyncEngine, SyncState } from "../src/sync";

let clock = 1_000_000;
export const tick = () => (clock += 1000);
const enc = new TextEncoder(), dec = new TextDecoder();
export const buf = (s: string) => enc.encode(s).buffer as ArrayBuffer;
const copy = (b: ArrayBuffer) => b.slice(0);

export class FakeDrive {
  files = new Map<string, { path: string; data: ArrayBuffer; modifiedTime: number; device: string; trashed: boolean }>();
  n = 0;
  /** Test switches: simulate a lost folder / failing or damaged transfers. */
  folderGone = false; failUpload = false; corruptDownload = false; folders = 0;
  async ensureFolder() { this.folders++; this.folderGone = false; return "folder" + this.folders; }
  async folderUsable() { return !this.folderGone; }
  /** Change feed like Google's: a token stands for a snapshot; changes = difference to now. */
  supportsChanges = true;
  private snapshots = new Map<string, Map<string, string>>();
  private snap() {
    const m = new Map<string, string>();
    for (const [id, f] of this.files) if (!f.trashed) m.set(id, `${f.path}|${SparkMD5.ArrayBuffer.hash(f.data)}|${f.modifiedTime}`);
    const token = `t${this.snapshots.size + 1}`;
    this.snapshots.set(token, m);
    return token;
  }
  async startPageToken() {
    if (!this.supportsChanges) throw new Error("changes not supported");
    return this.snap();
  }
  async listChanges(token: string) {
    if (!this.supportsChanges) throw new Error("changes not supported");
    const old = this.snapshots.get(token);
    if (!old) throw new Error("unknown token");
    const next = this.snap();
    const now = this.snapshots.get(next)!;
    const changed: RemoteEntry[] = [], removed: string[] = [];
    for (const [id, v] of now) if (old.get(id) !== v) changed.push(this.entry(id));
    for (const id of old.keys()) if (!now.has(id)) removed.push(id);
    return { changed, removed, token: next };
  }
  private entry(id: string): RemoteEntry {
    const f = this.files.get(id)!;
    return { id, path: f.path, md5: SparkMD5.ArrayBuffer.hash(f.data), modifiedTime: f.modifiedTime, device: f.device, size: f.data.byteLength };
  }
  async listFiles(): Promise<RemoteEntry[]> {
    return [...this.files.entries()].filter(([, f]) => !f.trashed).map(([id, f]) => ({
      id, path: f.path, md5: SparkMD5.ArrayBuffer.hash(f.data), modifiedTime: f.modifiedTime, device: f.device, size: f.data.byteLength }));
  }
  async download(id: string) {
    const d = copy(this.files.get(id)!.data);
    return this.corruptDownload ? d.slice(0, Math.floor(d.byteLength / 2)) : d;
  }
  async upload(_f: string, path: string, data: ArrayBuffer, device: string, id?: string, mtime?: number): Promise<RemoteEntry> {
    if (this.failUpload) throw new Error("Upload fehlgeschlagen");
    const hook = this.beforeUpload; this.beforeUpload = null; hook?.();
    id = id ?? `id${++this.n}`;
    const modifiedTime = mtime ?? tick();
    this.files.set(id, { path, data: copy(data), modifiedTime, device, trashed: false });
    return { id, path, md5: SparkMD5.ArrayBuffer.hash(data), modifiedTime, device };
  }
  async trash(id: string) { this.files.get(id)!.trashed = true; }
  /** Test hook: runs once before the next upload (e.g. another device writing in between). */
  beforeUpload: (() => void) | null = null;
  async getMeta(id: string): Promise<RemoteEntry | null> {
    const f = this.files.get(id);
    if (!f || f.trashed) return null;
    return { id, path: f.path, md5: SparkMD5.ArrayBuffer.hash(f.data), modifiedTime: f.modifiedTime, device: f.device, size: f.data.byteLength };
  }
}

export class FakeVault {
  configDir = ".obsidian";
  data = new Map<string, ArrayBuffer>();
  nodes = new Map<string, TFile>();
  /** Files outside Obsidian's index (settings folder, base copies). */
  hidden = new Map<string, { data: ArrayBuffer | string; mtime: number }>();
  getFiles() { return [...this.nodes.values()]; }
  getAbstractFileByPath(p: string) {
    if (this.nodes.has(p)) return this.nodes.get(p)!;
    const kids = [...this.nodes.keys()].filter((k) => k.startsWith(p + "/"));
    if (kids.length) { const f = new TFolder(); f.path = p; f.children = kids as never; return f; }
    return null;
  }
  /** Paths that cannot be read / written (simulates locked or broken files). */
  unreadable = new Set<string>(); unwritable = new Set<string>();
  async readBinary(f: TFile) {
    if (this.unreadable.has(f.path)) throw new Error("EACCES: permission denied");
    return copy(this.data.get(f.path)!);
  }
  async read(f: TFile) { return dec.decode(this.data.get(f.path)!); }
  async modifyBinary(f: TFile, d: ArrayBuffer) { if (this.unwritable.has(f.path)) throw new Error("EBUSY: file is locked"); this.set(f.path, d); }
  async createBinary(p: string, d: ArrayBuffer) {
    if (this.unwritable.has(p)) throw new Error("EINVAL: invalid file name");
    if (this.nodes.has(p)) throw new Error("exists"); this.set(p, d);
  }
  async createFolder() {}
  async delete() {}
  set(p: string, d: ArrayBuffer) {
    const f = this.nodes.get(p) ?? new TFile(p);
    f.stat = { mtime: tick(), size: d.byteLength, ctime: 0 };
    this.nodes.set(p, f); this.data.set(p, copy(d));
  }
  remove(p: string) { this.nodes.delete(p); this.data.delete(p); }
  text(p: string) { const d = this.data.get(p); return d ? dec.decode(d) : undefined; }
  private hiddenExists(p: string) {
    return this.hidden.has(p) || [...this.hidden.keys()].some((k) => k.startsWith(p + "/"));
  }
  setHidden(p: string, d: ArrayBuffer | string) { this.hidden.set(p, { data: d, mtime: tick() }); }
  hiddenText(p: string) {
    const e = this.hidden.get(p);
    if (!e) return undefined;
    return typeof e.data === "string" ? e.data : dec.decode(e.data);
  }
  adapter = {
    exists: async (p: string) => this.hiddenExists(p),
    mkdir: async () => {},
    rmdir: async (dir: string) => { for (const k of [...this.hidden.keys()]) if (k.startsWith(dir + "/")) this.hidden.delete(k); },
    write: async (p: string, t: string) => this.setHidden(p, t),
    writeBinary: async (p: string, d: ArrayBuffer) => this.setHidden(p, copy(d)),
    read: async (p: string) => this.hiddenText(p)!,
    readBinary: async (p: string) => {
      if (this.unreadable.has(p)) throw new Error("EACCES: permission denied");
      const e = this.hidden.get(p)!;
      return typeof e.data === "string" ? buf(e.data) : copy(e.data);
    },
    remove: async (p: string) => void this.hidden.delete(p),
    rename: async (a: string, b: string) => {
      for (const k of [...this.hidden.keys()]) {
        if (k === a || k.startsWith(a + "/")) { const e = this.hidden.get(k)!; this.hidden.delete(k); this.hidden.set(b + k.slice(a.length), e); }
      }
    },
    copy: async (a: string, b: string) => { const e = this.hidden.get(a); if (e) this.hidden.set(b, { ...e }); },
    stat: async (p: string) => {
      const e = this.hidden.get(p);
      if (!e) return null;
      const size = typeof e.data === "string" ? enc.encode(e.data).byteLength : e.data.byteLength;
      return { type: "file", mtime: e.mtime, size, ctime: 0 };
    },
    list: async (dir: string) => {
      if (this.unreadable.has(dir)) throw new Error("EACCES: permission denied");
      const files = new Set<string>(), folders = new Set<string>();
      for (const k of this.hidden.keys()) {
        if (!k.startsWith(dir + "/")) continue;
        const rest = k.slice(dir.length + 1);
        if (rest.includes("/")) folders.add(dir + "/" + rest.split("/")[0]);
        else files.add(k);
      }
      return { files: [...files], folders: [...folders] };
    },
  };
}

export function device(drive: FakeDrive, name: string, configEnabled = false) {
  const vault = new FakeVault();
  const state: SyncState = { base: {}, cache: {}, folderId: "", folderName: "" };
  const app = { vault, fileManager: { trashFile: async (f: { path: string }) => vault.remove(f.path) } };
  const config = { enabled: configEnabled, settings: true, appearance: true, plugins: true };
  const limits = { maxFileBytes: undefined as number | undefined };
  const backup = { enabled: true, keepDays: 30, maxTotalBytes: 100 * 1024 * 1024, maxFileBytes: 10 * 1024 * 1024 };
  const engine = new SyncEngine(app as never, drive as never, state,
    () => ({ folderName: "Test", deviceName: name, excludes: [".trash/**"], config, backup, maxFileBytes: limits.maxFileBytes }),
    ".obsidian/plugins/gdrive-vault-sync/base", async () => {});
  return { vault, state, engine, backup, limits, sync: (allowMassDelete = false, retryFailed = false) => engine.run(undefined, allowMassDelete, retryFailed), name, config };
}
