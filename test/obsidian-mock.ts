export class TAbstractFile { path = ""; }
export class TFile extends TAbstractFile { stat = { mtime: 0, size: 0, ctime: 0 }; constructor(p: string) { super(); this.path = p; } }
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; }
export const normalizePath = (p: string) => p.replace(/\/+/g, "/");
export const requestUrl = () => { throw new Error("no network in tests"); };
export const Platform = { isDesktopApp: false };
