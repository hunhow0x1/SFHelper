import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { findCacheDir } from "../src/gamedata/cache";
import { updateGameData } from "../src/gamedata/update";
import { Wiki } from "../src/gamedata/wiki";
import { loggedGame } from "../src/server/gameLog";

const PUBLIC_DIR = "src/server/public";

const { values } = parseArgs({
  options: {
    cache: { type: "string" },
    out: { type: "string", default: PUBLIC_DIR },
    "no-wiki": { type: "boolean", default: false },
  },
});

function shrinkIcon(png: Buffer): Buffer {
  const res = spawnSync("magick", ["png:-", "-resize", "64x64", "-strip", "png:-"], { input: png, maxBuffer: 16 << 20 });
  return res.status === 0 && res.stdout.length ? res.stdout : png;
}

const logged = await loggedGame();
const cacheDir = values.cache ?? (await findCacheDir(logged?.log ?? null, logged?.cacheDir ?? null));
if (!cacheDir) {
  console.error("Couldn't find Soulframe's Cache.Windows folder; pass it with --cache <dir>.");
  process.exit(1);
}
console.error(`Reading ${cacheDir}${logged?.build ? ` (build ${logged.build})` : ""}`);
const result = await updateGameData({
  cacheDir,
  outDir: values.out,
  bundledDir: PUBLIC_DIR,
  wiki: values["no-wiki"] ? null : new Wiki(),
  shrinkIcon,
  maxDownloads: Infinity,
  log: (m) => console.error(m),
});
console.log(result.summary);
if (result.failed.length) process.exitCode = 1;
