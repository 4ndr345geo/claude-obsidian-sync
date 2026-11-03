import SparkMD5 from "spark-md5";
import { TFile, TFolder } from "obsidian";
import type { RemoteEntry } from "../src/plan";

let clock = 1_000_000;
export const tick = () => (clock += 1000);
const enc = new TextEncoder(), dec = new TextDecoder();
export const buf = (s: string) => enc.encode(s).buffer as ArrayBuffer;
const copy = (b: ArrayBuffer) => b.slice(0);

export class FakeDrive {
  files = new Map<string, { path: string; data: ArrayBuffer; modifiedTime: number; device: string; trashed: boolean }>();
  n = 0;
  async ensureFolder() { return "folder"; }
  async listFiles(): Promise<RemoteEntry[]> {
    return [...this.files.entries()].filter(([, f]) => !f.trashed).map(([id, f]) => ({
      id, path: f.path, md5: SparkMD5.ArrayBuffer.hash(f.data), modifiedTime: f.modifiedTime, device: f.device }));
  }
  async download(id: string) { return copy(this.files.get(id)!.data); }
  async upload(_f: string, path: string, data: ArrayBuffer, device: string, id?: string, mtime?: number): Promise<RemoteEntry> {
    id = id ?? `id${++this.n}`;
    const modifiedTime = mtime ?? tick();
    this.files.set(id, { path, data: copy(data), modifiedTime, device, trashed: false });
    return { id, path, md5: SparkMD5.ArrayBuffer.hash(data), modifiedTime, device };
  }
  async trash(id: string) { this.files.get(id)!.trashed = true; }
}

export class FakeVault {
  configDir = ".obsidian";
  data = new Map<string, ArrayBuffer>();
  nodes = new Map<string, TFile>();
  hidden = new Map<string, string>();
  getFiles() { return [...this.nodes.values()]; }
  getAbstractFileByPath(p: string) {
    if (this.nodes.has(p)) return this.nodes.get(p)!;
    const kids = [...this.nodes.keys()].filter((k) => k.startsWith(p + "/"));
    if (kids.length) { const f = new TFolder(); f.path = p; f.children = kids as never; return f; }
    return null;
  }
  async readBinary(f: TFile) { return copy(this.data.get(f.path)!); }
  async read(f: TFile) { return dec.decode(this.data.get(f.path)!); }
  async modifyBinary(f: TFile, d: ArrayBuffer) { this.set(f.path, d); }
  async createBinary(p: string, d: ArrayBuffer) { if (this.nodes.has(p)) throw new Error("exists"); this.set(p, d); }
  async createFolder() {}
  async delete() {}
  set(p: string, d: ArrayBuffer) {
    const f = this.nodes.get(p) ?? new TFile(p);
    f.stat = { mtime: tick(), size: d.byteLength, ctime: 0 };
    this.nodes.set(p, f); this.data.set(p, copy(d));
  }
  remove(p: string) { this.nodes.delete(p); this.data.delete(p); }
  text(p: string) { const d = this.data.get(p); return d ? dec.decode(d) : undefined; }
  adapter = {
    exists: async (p: string) => this.hidden.has(p) || [...this.hidden.keys()].some((k) => k.startsWith(p + "/")),
    mkdir: async () => {},
    write: async (p: string, t: string) => void this.hidden.set(p, t),
    read: async (p: string) => this.hidden.get(p)!,
    remove: async (p: string) => void this.hidden.delete(p),
  };
}
