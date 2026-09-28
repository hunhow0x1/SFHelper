// Turn the extracted localization dict into the app's names file.
//
//   node scripts/extract_names.mjs --out dict.en.json      # pull the dict
//   node scripts/build_names.mjs dict.en.json names.json   # -> { items, factions }
//
// Host the resulting names.json at your SFHELPER_NAMES_URL endpoint.
//
// Factions map exactly: the profile's Affiliation "Tag" (e.g. SilentRoseSyndicate)
// -> /SF/Language/Syndicates/<stem>Name in the dict.
//
// Items are best-effort here: the dict keys are localization paths
// (/SF/Language/Weapons/FennJotarMeleeWeaponName = "Igne Mora"), whose stems do
// not always equal the profile's ItemType leaf (FennJotarSwordMeleeWeapon). We
// index every "*Name" string by its leaf stem so the dashboard's leaf lookup
// resolves where they align. The precise ItemType->name bridge needs the item
// definitions (parseable now that Oodle works via ooz-wasm) - see README.

import { readFile, writeFile } from "node:fs/promises";

const [dictPath = "dict.en.json", outPath = "names.json"] = process.argv.slice(2);
const dict = JSON.parse(await readFile(dictPath, "utf8"));

const FACTION_TAGS = ["ChampionSyndicate", "FeySyndicate", "OdeSyndicate", "SilentRoseSyndicate"];

const factions = {};
for (const tag of FACTION_TAGS) {
  const stem = tag.replace(/Syndicate$/, "");
  const name = dict[`/SF/Language/Syndicates/${stem}Name`];
  if (name) factions[tag] = name;
}

// Index every "<path>/<Stem>Name" display string by its leaf stem, so the
// dashboard (which looks up by ItemType leaf) can resolve matches.
const items = {};
for (const [key, value] of Object.entries(dict)) {
  if (typeof value !== "string" || !key.endsWith("Name")) continue;
  if (value.startsWith("[PH]") || value === "") continue; // skip placeholders
  const stem = key.slice(key.lastIndexOf("/") + 1, -"Name".length);
  if (stem && !(stem in items)) items[stem] = value;
}

const out = { items, factions };
await writeFile(outPath, JSON.stringify(out, null, 2));
console.error(
  `Wrote ${outPath}: ${Object.keys(items).length} item names, ${Object.keys(factions).length} factions.`,
);
