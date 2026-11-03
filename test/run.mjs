import esbuild from "esbuild";
import { readdirSync } from "fs";
import { spawnSync } from "child_process";
const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => "test/" + f);
await esbuild.build({ entryPoints: tests, bundle: true, platform: "node", format: "esm", outdir: "test/.out",
  outExtension: { ".js": ".mjs" }, alias: { obsidian: "./test/obsidian-mock.ts" }, logLevel: "error" });
const r = spawnSync(process.execPath, ["--test", ...readdirSync("test/.out").map((f) => "test/.out/" + f)], { stdio: "inherit" });
process.exit(r.status ?? 1);
