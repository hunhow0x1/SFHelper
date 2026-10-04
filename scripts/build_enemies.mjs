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
import { homedir } from "node:os";
import { join } from "node:path";

const [dictPath = "dict.en.json", pkgPath = join(homedir(), ".cache", "sfhelper-cache", "0", "Packages.bin_H")] =
  process.argv.slice(2);
const OUT = "src/server/public/enemies.json";

const dict = JSON.parse(await readFile(dictPath, "utf8"));
const usable = (v) => typeof v === "string" && v.trim() !== "" && !v.startsWith("[PH]") && v !== "???";

// --- parents, from the Packages.bin type tree --------------------------------
// The header part ends with the tree: u32 count, 8 bytes, then directory
// records { u32 len, path ("/SF/Types/.../"), u8, u32 n, n x entry } where an
// entry is { u32 len, leaf, 3 bytes, u32 len, parent (absolute, or a leaf in
// the same directory) }. We find directory records by pattern and decode their
// entries; each record self-validates by its length prefixes.
const buf = await readFile(pkgPath);
const parentOf = new Map(); // full path -> full parent path
const text = buf.toString("latin1");
const DIR_RE = /\/(?:SF|EE|Lotus)\/[A-Za-z0-9_/]*\/\x01/g;
for (let m; (m = DIR_RE.exec(text)); ) {
  const start = m.index;
  const dir = m[0].slice(0, -1);
  if (start < 4 || buf.readUInt32LE(start - 4) !== dir.length) continue;
  let i = start + dir.length + 1;
  const count = buf.readUInt32LE(i);
  i += 4;
  if (count > 100_000) continue;
  const found = [];
  try {
    for (let n = 0; n < count; n += 1) {
      const nl = buf.readUInt32LE(i);
      const leaf = buf.toString("latin1", i + 4, i + 4 + nl);
      i += 4 + nl + 3;
      const pl = buf.readUInt32LE(i);
      const parent = buf.toString("latin1", i + 4, i + 4 + pl);
      i += 4 + pl;
      if (!/^[\w.-]+$/.test(leaf)) throw new Error("not a record"); // e.g. "SpiderAnimTree.animtree"
      found.push([dir + leaf, parent.startsWith("/") ? parent : parent ? dir + parent : null]);
    }
  } catch {
    continue;
  }
  for (const [path, parent] of found) if (parent) parentOf.set(path, parent);
}
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
