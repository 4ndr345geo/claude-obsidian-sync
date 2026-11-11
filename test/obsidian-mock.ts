export class TAbstractFile { path = ""; }
export class TFile extends TAbstractFile { stat = { mtime: 0, size: 0, ctime: 0 }; constructor(p: string) { super(); this.path = p; } }
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; }
export const normalizePath = (p: string) => p.replace(/\/+/g, "/");
type Handler = (p: { url: string; method?: string; headers?: Record<string, string> }) => unknown;
let handler: Handler = () => { throw new Error("no network in tests"); };
/** Tests: answer requests with { status, json?, headers? } or throw to simulate "offline". */
export const setRequestHandler = (h: Handler) => { handler = h; };
export const requestUrl = async (p: Parameters<Handler>[0]) => handler(p);
export const Platform = { isDesktopApp: false };
