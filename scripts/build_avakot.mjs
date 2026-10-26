// Build Avakot's shop pool for the Avakot tab (src/server/public/avakot.json)
// and its icons (src/server/public/img/avakot/).
//
//   node scripts/extract_names.mjs --out dict.en.json              # localization dict
//   node scripts/build_avakot.mjs dict.en.json [Packages.bin_H] [--no-icons]
//
// The pool comes from the game's own vendor manifest for Avakot's Gots in
// Packages.bin: every item he can offer, its price range, how long an offer
// lasts, how often it's picked, its purchase limit, and whether it's always
// offered or limited per week. Names come from each store item's LocalizeTag
// (also in Packages.bin) looked up in the localization dict, so they match the
// game. The live stock is fetched by the desktop app (src/server/avakot.ts);
// this file only tells the dashboard what *could* be offered, so items can be
// starred before they show up.
//
// Icons are the game's art as hosted by the wiki (the Icon/Image fields of its
// Module:Data pages), resized to 64px. Joineries reuse img/joineries/.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { DEFAULT_PACKAGES_PATH } from "./type_tree.mjs";
import { readPackageTexts } from "./package_texts.mjs";

const args = process.argv.slice(2);
const withIcons = !args.includes("--no-icons");
const [dictPath = "dict.en.json", pkgPath = DEFAULT_PACKAGES_PATH] = args.filter((a) => !a.startsWith("--"));
const OUT = "src/server/public/avakot.json";
const ICON_DIR = "src/server/public/img/avakot";
const VENDOR = "/SF/Types/Game/AvakotVendorManifest";
const WIKI_API = "https://wiki.avakot.org/w/api.php";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";

const dict = JSON.parse(await readFile(dictPath, "utf8"));
const bundledNames = JSON.parse(await readFile("src/server/public/names.json", "utf8")).items ?? {};
const texts = [...new Set(readPackageTexts(await readFile(pkgPath)))];

// --- The manifest: the vendor manifest that sells fishing lures. -------------
const manifests = texts.filter(
  (t) => t.includes("ItemManifest={") && t.includes("NumItemsAvailable=") && t.includes("/Consumables/Tackle/"),
);
if (manifests.length !== 1) throw new Error(`expected one Avakot vendor manifest in ${pkgPath}, found ${manifests.length}`);
const manifest = manifests[0];

// --- Names: store items carry TypeName + LocalizeTag. ------------------------
const tagOf = new Map();
for (const t of texts) {
  const type = /^TypeName=(\S+)$/m.exec(t)?.[1];
  const tag = /^LocalizeTag=(\S+)$/m.exec(t)?.[1];
  if (type && tag && !tagOf.has(type)) tagOf.set(type, tag);
}
const usable = (v) => typeof v === "string" && v.trim() !== "" && !v.startsWith("[PH]") && v !== "???";
function nameOf(storeItem) {
  const type = storeItem.replace("/SF/StoreItems/", "/SF/");
  const fromTag = dict[tagOf.get(type)];
  if (usable(fromTag)) return fromTag.trim();
  const leaf = storeItem.slice(storeItem.lastIndexOf("/") + 1);
  return bundledNames[type] ?? bundledNames[leaf] ?? leaf.replace(/([a-z])([A-Z])/g, "$1 $2");
}

const GROUPS = [
  [/\/Consumables\/Tackle\//, "Lures"],
  [/\/Resources\/Bundles\/Catalysts\//, "Lampyrite"],
  [/\/Kintsugi\//, "Joineries"],
  [/\/Recipes\/Pacts\//, "Pact Fragments"],
  [/\/PickUps\/Resources\//, "Materials"],
  [/\/Consumables\//, "Supplies"],
];
const groupOf = (path) => GROUPS.find(([re]) => re.test(path))?.[1] ?? "Other";

// --- Items. --------------------------------------------------------------------
const field = (block, key) => new RegExp(`^${key}=(.*)$`, "m").exec(block)?.[1];
const pair = (s) => {
  const m = /^\{(-?[\d.]+),(-?[\d.]+)\}$/.exec(s ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
};
const items = [];
for (const [, storeItem, block] of manifest.matchAll(/\{\nStoreItem=([^\n]+)\n([\s\S]*?)\nIncreasePerNegativeRank=[^\n]*\n\}/g)) {
  const regular = pair(field(block, "RegularPrice"));
  const premium = pair(field(block, "PremiumPrice"));
  const [currency, price] =
    regular && regular[1] > 0 ? ["Dracs", regular] : premium && premium[1] > 0 ? ["Arcs", premium] : [null, null];
  const limit = Number(field(block, "PurchaseQuantityLimit"));
  items.push({
    storeItem,
    name: nameOf(storeItem),
    group: groupOf(storeItem),
    kind: field(block, "AlwaysOffered") === "1" ? "always" : field(block, "RotatedWeekly") === "1" ? "weekly" : "rotating",
    currency,
    price,
    hours: pair(field(block, "DurationAvailable")),
    weight: Number(Number(field(block, "AppearanceFrequency")).toFixed(3)),
    limit: limit > 0 ? limit : null,
  });
}
if (items.length < 10) throw new Error(`Avakot manifest: only ${items.length} items parsed`);
const slots = pair(field(manifest, "NumItemsAvailable"));

// --- Icons from the wiki. -------------------------------------------------------
const slug = (s) => s.toLowerCase().replace(/\.png$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const wiki = async (params) => {
  const r = await fetch(`${WIKI_API}?${new URLSearchParams({ format: "json", ...params })}`, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`wiki ${r.status}`);
  return r.json();
};

async function iconFiles() {
  const byName = new Map();
  for (const mod of ["CraftingResources", "Consumables", "Fish", "Misc", "Pacts"]) {
    const lua = (await wiki({ action: "parse", page: `Module:Data/${mod}`, prop: "wikitext" })).parse?.wikitext?.["*"] ?? "";
    for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\s*\},/g)) {
      const file = /\b(?:Img)?(?:Icon|Image)\s*=\s*"([^"]+\.png)"/.exec(m[2])?.[1];
      if (file && !byName.has(m[1])) byName.set(m[1], file);
    }
  }
  return byName;
}

async function download(file, out) {
  const q = await wiki({ action: "query", prop: "imageinfo", iiprop: "url", titles: `File:${file}` });
  const src = Object.values(q.query?.pages ?? {})[0]?.imageinfo?.[0]?.url;
  if (!src) return false;
  const png = Buffer.from(await (await fetch(src, { headers: { "user-agent": UA } })).arrayBuffer());
  const res = spawnSync("magick", ["png:-", "-resize", "64x64", "-strip", out], { input: png });
  if (res.status !== 0) await writeFile(out, png);
  return true;
}

if (withIcons) {
  await mkdir(ICON_DIR, { recursive: true });
  const files = await iconFiles();
  const missing = [];
  const done = new Map();
  const fetchIcon = async (file) => {
    if (!done.has(file)) {
      const rel = `img/avakot/${slug(file)}.png`;
      done.set(file, (await download(file, `src/server/public/${rel}`)) ? rel : null);
    }
    return done.get(file);
  };
  for (const it of items) {
    if (it.group === "Joineries") {
      it.icon = `img/joineries/${it.name.split(":")[0].trim().toLowerCase()}.png`;
      continue;
    }
    // "Purseworth of Glow Lampyrite" uses the Glow Lampyrite art.
    const file = files.get(it.name) ?? files.get(/ of (.+ Lampyrite)$/.exec(it.name)?.[1] ?? "");
    it.icon = file ? await fetchIcon(file) : null;
    if (!it.icon) missing.push(it.name);
  }
  for (const [file, name] of [["DracsCurrencyIcon.png", "dracs"], ["Arcs.png", "arcs"]]) {
    if (!(await download(file, `${ICON_DIR}/${name}.png`))) missing.push(file);
  }
  if (missing.length) console.warn(`No icon for: ${missing.join(", ")}`);
} else {
  // Keep the icons from the last full build.
  try {
    const prev = new Map(JSON.parse(await readFile(OUT, "utf8")).items.map((i) => [i.storeItem, i.icon]));
    for (const it of items) it.icon = prev.get(it.storeItem) ?? null;
  } catch {
    for (const it of items) it.icon = null;
  }
}

await writeFile(OUT, `${JSON.stringify({ vendor: VENDOR, slots: slots ? slots[1] : null, items }, null, 2)}\n`);
const count = (k) => items.filter((i) => i.kind === k).length;
console.log(`Wrote ${OUT}: ${items.length} items (${count("rotating")} rotating, ${count("weekly")} weekly, ${count("always")} always).`);
