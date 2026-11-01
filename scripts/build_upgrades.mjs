import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { DEFAULT_PACKAGES_PATH } from "./type_tree.mjs";
import { readPackageTexts } from "./package_texts.mjs";

const args = process.argv.slice(2);
const withIcons = !args.includes("--no-icons");
const [dictPath = "dict.en.json", pkgPath = DEFAULT_PACKAGES_PATH] = args.filter((a) => !a.startsWith("--"));
const OUT = "src/server/public/upgrades.json";
const RUNE_ICON_DIR = "src/server/public/img/runes";
const WIKI_API = "https://wiki.avakot.org/w/api.php";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const GAP_MS = 150;
const JOINERY_FAMILIES = ["Verite", "Quicksilver", "Feybalt", "Gildaur"];

const dict = JSON.parse(await readFile(dictPath, "utf8"));
const itemIcons = JSON.parse(await readFile("src/server/public/itemicons.json", "utf8"));
const texts = [...new Set(readPackageTexts(await readFile(pkgPath)))];

const usable = (v) => typeof v === "string" && v.trim() !== "" && !v.startsWith("[PH]") && v !== "???";
const field = (t, key) => new RegExp(`^${key}=(.*)$`, "m").exec(t)?.[1];
const loc = (tag) => (tag && usable(dict[tag]) ? dict[tag].trim().replace(/\s+/g, " ") : null);
const searchTags = (t) => (/^SearchTags=\{\n([\s\S]*?)\n\}/m.exec(t)?.[1] ?? "").split("\n").map((x) => loc(x.replace(/,$/, ""))).filter(Boolean);
const slug = (s) => s.toLowerCase().replace(/\.png$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const exists = (p) => access(p).then(() => true, () => false);
const pause = () => new Promise((r) => setTimeout(r, GAP_MS));
const wiki = async (params) => {
  await pause();
  const r = await fetch(`${WIKI_API}?${new URLSearchParams({ format: "json", ...params })}`, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`wiki ${r.status}`);
  return r.json();
};

const items = new Map();
for (const t of texts) {
  const type = field(t, "TypeName");
  const cat = field(t, "ProductCategory");
  const name = loc(field(t, "LocalizeTag"));
  if (!type || !cat || !name || items.has(type)) continue;
  items.set(type, { t, cat, name });
}

async function wikiModule(page) {
  const lua = (await wiki({ action: "parse", page, prop: "wikitext" })).parse?.wikitext?.["*"] ?? "";
  const out = [];
  for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\s*\},?\s*\n/g)) {
    const body = m[2];
    const str = (k) => new RegExp(`\\b${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body)?.[1]?.replace(/\\"/g, '"') ?? null;
    const stats = [...body.matchAll(/\{\s*Effect\s*=\s*"((?:[^"\\]|\\.)*)"\s*,\s*Ranks\s*=\s*"([^"]*)"\s*\}/g)].map((s) => ({
      effect: s[1].replace(/\\"/g, '"'),
      values: s[2].split("/").map((v) => v.trim()),
    }));
    out.push({ name: m[1], id: str("InternalID"), icon: str("ImgIcon"), art: str("WeaponArt"), does: str("Functionality"), slot: str("AddedSlot"), stats });
  }
  return out;
}

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

const wikiRunes = new Map((await wikiModule("Module:Data/Runes")).filter((r) => r.id).map((r) => [r.id, r]));
if (wikiRunes.size < 10) throw new Error(`only ${wikiRunes.size} runes on the wiki's Module:Data/Runes`);
if (withIcons) await mkdir(RUNE_ICON_DIR, { recursive: true });

const runes = {};
const missingIcons = [];
for (const [type, { t, cat, name }] of items) {
  if (cat !== "Upgrades" || !type.startsWith("/SF/Upgrades/Runes/Weapon/")) continue;
  const w = wikiRunes.get(type);
  const iconFile = w?.icon ?? field(t, "Icon")?.split("/").pop() ?? null;
  let icon = null;
  if (iconFile) {
    const out = `${RUNE_ICON_DIR}/${slug(iconFile)}.png`;
    if ((await exists(out)) || (withIcons && (await download(iconFile, out)))) icon = `img/runes/${slug(iconFile)}.png`;
    else missingIcons.push(name);
  }
  runes[type] = {
    name,
    desc: loc(field(t, "LocalizeDescTag")),
    art: searchTags(t)[0] ?? w?.art ?? null,
    does: w?.does ?? null,
    slot: w?.slot ?? null,
    stats: w?.stats ?? [],
    icon,
  };
}

const joineries = {};
for (const [type, { t, cat, name }] of items) {
  if (cat !== "Upgrades" || !type.startsWith("/SF/Types/Items/Kintsugi/")) continue;
  const family = JOINERY_FAMILIES.find((f) => name.startsWith(`${f}:`)) ?? null;
  joineries[type] = {
    name,
    family,
    desc: loc(field(t, "LocalizeDescTag")),
    rarity: field(t, "Rarity") ?? null,
    icon: `img/joineries/${family ? family.toLowerCase() : "joinery"}.png`,
  };
}

const iconByName = new Map();
for (const [k, v] of Object.entries(itemIcons)) {
  iconByName.set(k, v);
  const base = k.replace(/\s*\([^)]*\)$/, "");
  if (!iconByName.has(base)) iconByName.set(base, v);
}
const gear = {};
for (const [type, { t, cat, name }] of items) {
  if (cat !== "Consumables" || !type.startsWith("/SF/Types/Items/Consumables/")) continue;
  gear[type] = {
    name,
    desc: loc(field(t, "LocalizeDescTag")),
    kind: type.includes("/Tackle/") || type.includes("FishingSpool") ? "Fishing" : type.includes("/PetConsumeables/") || type.includes("PetFood") ? "Companion" : "Supplies",
    icon: iconByName.get(name) ?? null,
  };
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(OUT, `${JSON.stringify({ runes: sorted(runes), joineries: sorted(joineries), gear: sorted(gear) }, null, 2)}\n`);
console.log(
  `Wrote ${OUT}: ${Object.keys(runes).length} runes (${Object.values(runes).filter((r) => r.stats.length).length} with stats), ` +
    `${Object.keys(joineries).length} joineries, ${Object.keys(gear).length} gear items` +
    (missingIcons.length ? `; no rune icon for: ${missingIcons.join(", ")}` : "") +
    ".",
);
