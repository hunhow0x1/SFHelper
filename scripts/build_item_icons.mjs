// Item icons for the Trades tab (src/server/public/itemicons.json + img/items/):
// in-game name -> icon, for crafting materials, consumables, fish and weapons.
//
//   node scripts/build_item_icons.mjs
//
// The icons are the game's art as hosted by the Soulframe Wiki (the Icon/Image
// fields of its Module:Data pages), resized to 64px like Avakot's. Icons that
// build_avakot.mjs already fetched (img/avakot/) are reused, not downloaded
// again. Requests are spaced out to go easy on the wiki.

import { access, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const OUT = "src/server/public/itemicons.json";
const ICON_DIR = "src/server/public/img/items";
const WIKI_API = "https://wiki.avakot.org/w/api.php";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const MODULES = ["CraftingResources", "Consumables", "Fish", "Weapons"];
const GAP_MS = 150;

const pause = () => new Promise((r) => setTimeout(r, GAP_MS));
const slug = (s) => s.toLowerCase().replace(/\.png$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const exists = (p) => access(p).then(() => true, () => false);
const wiki = async (params) => {
  await pause();
  const r = await fetch(`${WIKI_API}?${new URLSearchParams({ format: "json", ...params })}`, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`wiki ${r.status}`);
  return r.json();
};

// --- Name -> icon file, from the Module:Data pages. ------------------------------
const files = new Map();
for (const mod of MODULES) {
  const lua = (await wiki({ action: "parse", page: `Module:Data/${mod}`, prop: "wikitext" })).parse?.wikitext?.["*"] ?? "";
  for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\s*\},/g)) {
    const file = /\b(?:Img)?(?:Icon|Image)\s*=\s*"([^"]+\.png)"/.exec(m[2])?.[1];
    if (file && !files.has(m[1])) files.set(m[1], file);
  }
}
if (files.size < 50) throw new Error(`only ${files.size} icons listed on the wiki's Module:Data pages`);

async function download(file, out) {
  const q = await wiki({ action: "query", prop: "imageinfo", iiprop: "url", titles: `File:${file}` });
  const src = Object.values(q.query?.pages ?? {})[0]?.imageinfo?.[0]?.url;
  if (!src) return false;
  await pause();
  const png = Buffer.from(await (await fetch(src, { headers: { "user-agent": UA } })).arrayBuffer());
  const res = spawnSync("magick", ["png:-", "-resize", "64x64", "-strip", out], { input: png });
  if (res.status !== 0) await writeFile(out, png);
  return true;
}

// --- Fetch each file once. -------------------------------------------------------
await mkdir(ICON_DIR, { recursive: true });
const icons = {};
const byFile = new Map();
const missing = [];
let fetched = 0;
for (const [name, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  if (!byFile.has(file)) {
    const s = slug(file);
    let rel = null;
    if (await exists(`src/server/public/img/avakot/${s}.png`)) rel = `img/avakot/${s}.png`;
    else if (await exists(`${ICON_DIR}/${s}.png`) || (await download(file, `${ICON_DIR}/${s}.png`).then((ok) => ok && ++fetched))) rel = `img/items/${s}.png`;
    byFile.set(file, rel);
  }
  if (byFile.get(file)) icons[name] = byFile.get(file);
  else missing.push(name);
}

await writeFile(OUT, `${JSON.stringify(icons, null, 2)}\n`);
console.log(`Wrote ${OUT}: ${Object.keys(icons).length} icons (${fetched} downloaded)${missing.length ? `; no file for: ${missing.join(", ")}` : ""}.`);
