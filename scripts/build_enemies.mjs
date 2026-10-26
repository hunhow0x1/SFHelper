// Build the enemy-name data the Stats tab uses (src/server/public/enemies.json).
//
//   node scripts/extract_names.mjs --out dict.en.json            # localization dict
//   node scripts/build_enemies.mjs dict.en.json [Packages.bin_H]  # -> enemies.json
//
// The profile's kill stats key enemies by type path
// (/SF/Types/Enemies/Sinecure/Soldier/MeleeGruntAvatar). Their in-game names
// live in the localization dict, mostly as Codex entries named after the
// type's leaf (/SF/Language/Codex/MeleeGruntAvatarName = "Sinecure Soldier").
// Many variants (elites, night versions...) have no entry of their own and take
// their parent type's name, so we also ship each enemy type's parent, read
// from the type tree in Packages.bin (its header part, as cached by
// extract_names/explore_cache under ~/.cache/sfhelper-cache). Purely local:
// no network.
//
// Output: { names: { leafLowercase: name }, parents: { leaf: parentLeaf } }.
// Resolution (walk parents, variant-word fallbacks) is in src/server/enemies.ts.

import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_PACKAGES_PATH, readTypeTree } from "./type_tree.mjs";

const [dictPath = "dict.en.json", pkgPath = DEFAULT_PACKAGES_PATH] = process.argv.slice(2);
const OUT = "src/server/public/enemies.json";

const dict = JSON.parse(await readFile(dictPath, "utf8"));
const usable = (v) => typeof v === "string" && v.trim() !== "" && !v.startsWith("[PH]") && v !== "???";

// --- parents, from the Packages.bin type tree (see type_tree.mjs) -------------
const parentOf = new Map(); // full path -> full parent path
for (const [path, parent] of readTypeTree(await readFile(pkgPath))) if (parent) parentOf.set(path, parent);
if (parentOf.size === 0) throw new Error(`no type tree found in ${pkgPath}`);

// Keep enemy types and their ancestors, keyed by leaf.
const leafOf = (p) => p.slice(p.lastIndexOf("/") + 1);
const parents = {};
for (const path of parentOf.keys()) {
  if (!path.startsWith("/SF/Types/Enemies/")) continue;
  for (let p = path, hops = 0; parentOf.has(p) && hops < 20; p = parentOf.get(p), hops += 1) {
    const leaf = leafOf(p);
    if (!(leaf in parents)) parents[leaf] = leafOf(parentOf.get(p));
  }
}

// --- names, by type leaf (lowercased: the dict mixes "Subboss"/"SubBoss") ----
const names = {};
const add = (leaf, value) => {
  const k = leaf.toLowerCase();
  if (usable(value) && !(k in names)) names[k] = value.trim();
};
const CODEX = "/SF/Language/Codex/";
const TITLES = "/SF/Language/Titles/";
const CHARACTERS = "/SF/Language/Characters/";
// 1. Codex: <Leaf>Name.
for (const [k, v] of Object.entries(dict)) {
  if (k.startsWith(CODEX) && k.endsWith("AvatarName")) add(k.slice(CODEX.length, -"Name".length), v);
}
// 2. Kill titles: <Leaf>KillTitle_Req = 'Defeat the "Banneret Toshtan" Agari.'
for (const [k, v] of Object.entries(dict)) {
  if (!k.startsWith(TITLES) || !k.endsWith("AvatarKillTitle_Req") || typeof v !== "string") continue;
  const quoted = v.match(/"([^"]+)"/);
  if (quoted) add(k.slice(TITLES.length, -"KillTitle_Req".length), quoted[1]);
}
// 3. Characters: <Name> for an existing <Name>Avatar enemy type (bosses such
//    as TempestBayor). The section also holds dialogue lines, hence the check.
const enemyLeaves = new Set(Object.keys(parents).map((l) => l.toLowerCase()));
for (const [k, v] of Object.entries(dict)) {
  if (!k.startsWith(CHARACTERS)) continue;
  const leaf = k.slice(CHARACTERS.length) + "Avatar";
  if (enemyLeaves.has(leaf.toLowerCase())) add(leaf, v);
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(OUT, `${JSON.stringify({ names: sorted(names), parents: sorted(parents) }, null, 1)}\n`);
console.error(`Wrote ${OUT}: ${Object.keys(names).length} names, ${Object.keys(parents).length} parent links.`);
