import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const OUT = "dist/electron";
await rm("dist", { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const external = ["electron", "koffi", "electron-updater"];

await build({
  entryPoints: ["electron/main.ts"],
  outfile: `${OUT}/main.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external,
  banner: { js: "// SFHelper — bundled Electron main" },
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
await cp("src/server/public", `${OUT}/public`, { recursive: true });

console.log("Built dist/electron (main.js, preload.cjs, consent.html, public/).");
