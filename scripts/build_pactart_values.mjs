// The numbers behind Pact Arts, from the game's data, for the Loadouts tab's
// Pact Arts popups (src/server/public/pactartvalues.json).
//
//   node scripts/build_pactart_values.mjs dict.en.json [Packages.bin_H]
//
// (dict.en.json as for build_locations.mjs.) Each art is an upgrade item with
// LocalizeTag=/SF/Language/Pacts/... and an Upgrades list: a stat (UpgradeType,
// or SymbolFilter for skill unlocks) and its value per point, e.g. Forestall's
// PREVENT_DEATH_SKILL_CHANCE 0.1. Arts are matched to pactarts.json by their
// in-game name. Only stats with a wording below are kept: ability unlocks have
// no number, and the Virtue arts are shown from their own table. Values are per
// point; the popup multiplies by the points spent, as the wiki shows for
// Physic (+1 per point) and Wingspan (7 / 14 seconds).

import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_PACKAGES_PATH } from "./type_tree.mjs";
import { readPackageTexts } from "./package_texts.mjs";

const [dictPath = "dict.en.json", pkgPath = DEFAULT_PACKAGES_PATH] = process.argv.slice(2);
const OUT = "src/server/public/pactartvalues.json";

// Stat -> how the popup words it. `scale` turns the game's value into the shown one.
const WORDING = {
  PREVENT_DEATH_SKILL_CHANCE: { scale: 100, unit: "%", label: "chance to survive a killing blow" },
  PREVENT_DEATH_SKILL_HEAL: { label: "Health restored when it saves you" },
  PREVENT_STABILITY_BREAK_SKILL_CHANCE: { scale: 100, unit: "%", label: "chance to resist being knocked down" },
  AVATAR_HEALTH_MAX: { sign: true, label: "max Health" },
  AVATAR_STABILITY_MAX: { sign: true, label: "max Stability" },
  AVATAR_RESPAWN_TIME: { sign: true, scale: 100, unit: "%", label: "time before you're revived at a Revive Shrine" },
  GAMEPLAY_GEAR_ITEM_MAXSTACK: { sign: true, label: "Life Elixir capacity" },
  GAMEPLAY_POWER_COOLDOWN: { sign: true, scale: 100, unit: "%", label: "ability cooldown" },
};

const dict = JSON.parse(await readFile(dictPath, "utf8"));
const arts = JSON.parse(await readFile("src/server/public/pactarts.json", "utf8"));
const texts = readPackageTexts(await readFile(pkgPath));

// In-game name -> its upgrade item's stats (upgrade items carry a FusionLimit).
const statsByName = new Map();
for (const t of texts) {
  const tag = /^LocalizeTag=(\/SF\/Language\/Pacts\/\S+)$/m.exec(t)?.[1];
  if (!tag || !/^FusionLimit=/m.test(t) || !/^Upgrades=\{/m.test(t)) continue;
  const name = dict[tag]?.trim();
  if (!name) continue;
  const stats = [];
  for (const [, type, value, filter] of t.matchAll(/UpgradeType=(\S+)\nOperationType=\S+\nValue=(\S+)[\s\S]*?SymbolFilter=(\S*)/g)) {
    const stat = filter && filter !== '""' ? filter : type;
    const w = WORDING[stat];
    if (!w) continue;
    const n = Number((Number(value) * (w.scale ?? 1)).toFixed(4));
    stats.push({ n: w.sign ? n : Math.abs(n), unit: w.unit ?? "", sign: !!w.sign, label: w.label });
  }
  if (stats.length) statsByName.set(name, stats);
}

const out = {};
for (const [key, def] of Object.entries(arts)) {
  if (def.virtue) continue;
  const stats = statsByName.get(def.name);
  if (stats) out[key] = stats;
}
await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${OUT}: ${Object.keys(out).length} Pact Arts with numbers (${Object.values(arts).filter((a) => !a.virtue).length} without a Virtue in pactarts.json).`);
