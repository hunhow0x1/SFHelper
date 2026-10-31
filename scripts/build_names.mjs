import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_PACKAGES_PATH, readTypeTree } from "./type_tree.mjs";
import { matchArmourStem } from "./armour_names.mjs";

const [dictPath = "dict.en.json", outPath = "names.json", pkgPath = DEFAULT_PACKAGES_PATH] = process.argv.slice(2);
const dict = JSON.parse(await readFile(dictPath, "utf8"));

const FACTION_TAGS = ["ChampionSyndicate", "FeySyndicate", "OdeSyndicate", "SilentRoseSyndicate"];

const factions = {};
const factionTokens = {};
for (const tag of FACTION_TAGS) {
  const name = dict[`/SF/Language/Syndicates/${tag.replace(/Syndicate$/, "")}Name`];
  if (name) factions[tag] = name;
  const token = dict[`/SF/Language/Syndicates/${tag}RepTokenName`];
  if (token) factionTokens[tag] = token;
}

const CURRENCY_FIELDS = {
  RegularCredits: "/SF/Language/Currency/CurrencyName",
  PremiumCredits: "/SF/Language/Currency/PremiumCurrencyName",
  PremiumCreditsFree: "/SF/Language/Currency/PremiumCurrencyName",
  FusionPoints: "/SF/Language/Currency/CurrencyMoteDustName",
};
const currencies = {};
for (const [field, key] of Object.entries(CURRENCY_FIELDS)) {
  if (dict[key]) currencies[field] = dict[key];
}

const MANUAL_OVERRIDES = {
  FennJotarSwordMeleeWeapon: dict["/SF/Language/Weapons/FennJotarMeleeWeaponName"],
  WolfSoul: dict["/SF/Language/Pacts/OrengalName"],
  StagSoul: dict["/SF/Language/Pacts/GarrenName"],
  SecondaryOdeSawDaggerMeleeWeapon: dict["/SF/Language/Weapons/OdeSecondarySawSwordMeleeWeaponName"],
  HealRip: dict["/SF/Language/Motes/HealAoeRipName"],
  IronIngot: dict["/SF/Language/Materials/IronIgotName"],
};

const items = {};
const setPrimary = (key, value) => {
  if (key) items[key] = value;
};
const setAlias = (key, value) => {
  if (key && !(key in items)) items[key] = value;
};

function weaponAliases(stem) {
  const out = new Set();
  if (stem.endsWith("RangedMelee")) out.add(stem + "Weapon");
  if (stem.endsWith("Weapon") && !stem.endsWith("MeleeWeapon")) {
    const base = stem.slice(0, -"Weapon".length);
    out.add(base + "MeleeWeapon");
    out.add(base + "RangedMeleeWeapon");
  }
  if (stem.includes("Sword")) out.add(stem.replaceAll("Sword", "Swords"));
  return out;
}

for (const [key, value] of Object.entries(dict)) {
  if (typeof value !== "string" || !key.endsWith("Name")) continue;
  if (value === "" || value.startsWith("[PH]")) continue;
  const stem = key.slice(key.lastIndexOf("/") + 1, -"Name".length);
  if (stem && !(stem in items)) setPrimary(stem, value);
}

for (const [key, value] of Object.entries(dict)) {
  if (typeof value !== "string" || !key.endsWith("Name")) continue;
  if (value === "" || value.startsWith("[PH]")) continue;
  const stem = key.slice(key.lastIndexOf("/") + 1, -"Name".length);
  if (key.startsWith("/SF/Language/Weapons/")) {
    for (const alias of weaponAliases(stem)) setAlias(alias, value);
  } else if (key.startsWith("/SF/Language/Pacts/")) {
    setAlias(stem + "Soul", value);
  }
}

const armourStems = Object.keys(dict)
  .filter((k) => k.startsWith("/SF/Language/Armour/") && k.endsWith("Name"))
  .map((k) => k.slice("/SF/Language/Armour/".length, -"Name".length));
let tree = null;
try {
  tree = readTypeTree(await readFile(pkgPath));
} catch {
  console.error(`(no type tree at ${pkgPath}: armour aliases skipped)`);
}
let armourAliases = 0;
for (const path of tree?.keys() ?? []) {
  const m = path.match(/^\/SF\/Upgrades\/Skins\/(Helmets|Body|Legs)\/(\w+)$/);
  if (!m || m[2] in items) continue;
  const stem = matchArmourStem(m[2], m[1], armourStems);
  const name = stem && dict[`/SF/Language/Armour/${stem}Name`];
  if (name && !name.startsWith("[PH]")) {
    setAlias(m[2], name);
    armourAliases++;
  }
}
for (const path of tree?.keys() ?? []) {
  const leaf = path.match(/^\/SF\/Upgrades\/Skins\/Helmets\/(Hair\d+AHelmet)$/)?.[1];
  if (leaf) setAlias(leaf, dict["/SF/Language/Armour/NoHelmetName"]);
}

for (const [key, value] of Object.entries(MANUAL_OVERRIDES)) {
  if (value) items[key] = value;
}

const out = { items, factions, factionTokens, currencies };
await writeFile(outPath, JSON.stringify(out, null, 2));
console.error(
  `Wrote ${outPath}: ${Object.keys(items).length} item names (${armourAliases} armour aliases), ${Object.keys(factions).length} factions, ${Object.keys(factionTokens).length} tokens, ${Object.keys(currencies).length} currencies.`,
);
