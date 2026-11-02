import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const OUT = "dist/electron";
await rm("dist", { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const external = ["electron", "koffi", "electron-updater"];
const cjsShim = [
  'import { createRequire as __sfhRequire } from "node:module";',
  'import { dirname as __sfhDirname } from "node:path";',
  'import { fileURLToPath as __sfhPath } from "node:url";',
  "const require = __sfhRequire(import.meta.url);",
  "const __filename = __sfhPath(import.meta.url);",
  "const __dirname = __sfhDirname(__filename);",
].join("\n");

await build({
  entryPoints: ["electron/main.ts"],
  outfile: `${OUT}/main.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external,
  banner: { js: `// SFHelper — bundled Electron main\n${cjsShim}` },
  logLevel: "info",
});

await build({
  entryPoints: ["electron/preload.ts"],
  outfile: `${OUT}/preload.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external,
  logLevel: "info",
});

await cp("electron/consent.html", `${OUT}/consent.html`);
await cp("node_modules/@bokuweb/zstd-wasm/dist/common/zstd.wasm", `${OUT}/zstd.wasm`);
await cp("src/server/public", `${OUT}/public`, { recursive: true });

console.log("Built dist/electron (main.js, preload.cjs, consent.html, zstd.wasm, public/).");
