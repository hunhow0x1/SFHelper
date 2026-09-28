// Turn the extracted localization dict into the app's names file.
//
//   node scripts/extract_names.mjs --out dict.en.json      # pull the dict
//   node scripts/build_names.mjs dict.en.json names.json   # -> { items, factions }
//
// Host the resulting names.json at your SFHELPER_NAMES_URL endpoint.
//
// The dict is keyed by localization paths (e.g.
// /SF/Language/Weapons/FeySwordMeleeWeaponName = "Dewelion"), whose leaf stem
// usually equals the profile's ItemType leaf ("FeySwordMeleeWeapon"). We index
// every "*Name" string by that stem, then add category-aware aliases for the
// cases where the two diverge (verified against a live profile):
//   * weapons: RangedMelee<->RangedMeleeWeapon, Weapon->(Melee|RangedMelee)Weapon,
//     Sword->Swords - each maps the dict stem onto the ItemType leaf form.
//   * souls: /SF/Souls/<Char>/<Char>Soul takes its name from
//     /SF/Language/Pacts/<Char>Name, so every Pacts "<X>Name" also aliases
//     "<X>Soul".
// Aliases never overwrite an exact stem match. A handful of items are simply
// unnamed in the dict (e.g. StagSoul) and fall back to the cleaned leaf.

import { readFile, writeFile } from "node:fs/promises";

const [dictPath = "dict.en.json", outPath = "names.json"] = process.argv.slice(2);
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

// Internal currency field (as seen in inventory.php) -> its dict display name.
const CURRENCY_FIELDS = {
  RegularCredits: "/SF/Language/Currency/CurrencyName", // Dracs
  PremiumCredits: "/SF/Language/Currency/PremiumCurrencyName", // Arcs
  PremiumCreditsFree: "/SF/Language/Currency/PremiumCurrencyName",
  FusionPoints: "/SF/Language/Currency/CurrencyMoteDustName", // Harmonies
};
const currencies = {};
for (const [field, key] of Object.entries(CURRENCY_FIELDS)) {
  if (dict[key]) currencies[field] = dict[key];
}

// A few items have dict keys the heuristics cannot derive (the dict drops or
// reshapes part of the name, e.g. "FennJotar" vs the ItemType's "FennJotarSword").
// List only ones confirmed against the dict; everything else is automatic.
const MANUAL_OVERRIDES = {
  FennJotarSwordMeleeWeapon: dict["/SF/Language/Weapons/FennJotarMeleeWeaponName"],
  // Some souls' internal family differs from their pact's character name.
  WolfSoul: dict["/SF/Language/Pacts/OrengalName"], // -> Orengall
  StagSoul: dict["/SF/Language/Pacts/GarrenName"], // -> Garren Rood
};

const items = {};
const setPrimary = (key, value) => {
  if (key) items[key] = value; // primary: authoritative, may overwrite
};
const setAlias = (key, value) => {
  if (key && !(key in items)) items[key] = value; // fill gaps only
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

// Pass 1 - primary index by exact leaf stem.
for (const [key, value] of Object.entries(dict)) {
  if (typeof value !== "string" || !key.endsWith("Name")) continue;
  if (value === "" || value.startsWith("[PH]")) continue;
  const stem = key.slice(key.lastIndexOf("/") + 1, -"Name".length);
  if (stem && !(stem in items)) setPrimary(stem, value);
}

// Pass 2 - category-aware aliases (never clobber a primary).
for (const [key, value] of Object.entries(dict)) {
  if (typeof value !== "string" || !key.endsWith("Name")) continue;
  if (value === "" || value.startsWith("[PH]")) continue;
  const stem = key.slice(key.lastIndexOf("/") + 1, -"Name".length);
  if (key.startsWith("/SF/Language/Weapons/")) {
    for (const alias of weaponAliases(stem)) setAlias(alias, value);
  } else if (key.startsWith("/SF/Language/Pacts/")) {
    setAlias(stem + "Soul", value); // <Char>Name -> <Char>Soul
  }
}

// Manual overrides win over everything (skip any that were not in the dict).
for (const [key, value] of Object.entries(MANUAL_OVERRIDES)) {
  if (value) items[key] = value;
}

const out = { items, factions, factionTokens, currencies };
await writeFile(outPath, JSON.stringify(out, null, 2));
console.error(
  `Wrote ${outPath}: ${Object.keys(items).length} item names, ${Object.keys(factions).length} factions, ${Object.keys(factionTokens).length} tokens, ${Object.keys(currencies).length} currencies.`,
);
