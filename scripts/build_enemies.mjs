import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_PACKAGES_PATH, readTypeTree } from "./type_tree.mjs";

const [dictPath = "dict.en.json", pkgPath = DEFAULT_PACKAGES_PATH] = process.argv.slice(2);
const OUT = "src/server/public/enemies.json";

const dict = JSON.parse(await readFile(dictPath, "utf8"));
const usable = (v) => typeof v === "string" && v.trim() !== "" && !v.startsWith("[PH]") && v !== "???";

const parentOf = new Map();
for (const [path, parent] of readTypeTree(await readFile(pkgPath))) if (parent) parentOf.set(path, parent);
if (parentOf.size === 0) throw new Error(`no type tree found in ${pkgPath}`);

const leafOf = (p) => p.slice(p.lastIndexOf("/") + 1);
const parents = {};
for (const path of parentOf.keys()) {
  if (!path.startsWith("/SF/Types/Enemies/")) continue;
  for (let p = path, hops = 0; parentOf.has(p) && hops < 20; p = parentOf.get(p), hops += 1) {
    const leaf = leafOf(p);
    if (!(leaf in parents)) parents[leaf] = leafOf(parentOf.get(p));
  }
}

const names = {};
const add = (leaf, value) => {
  const k = leaf.toLowerCase();
  if (usable(value) && !(k in names)) names[k] = value.trim();
};
const CODEX = "/SF/Language/Codex/";
const TITLES = "/SF/Language/Titles/";
const CHARACTERS = "/SF/Language/Characters/";
for (const [k, v] of Object.entries(dict)) {
  if (k.startsWith(CODEX) && k.endsWith("AvatarName")) add(k.slice(CODEX.length, -"Name".length), v);
}
for (const [k, v] of Object.entries(dict)) {
  if (!k.startsWith(TITLES) || !k.endsWith("AvatarKillTitle_Req") || typeof v !== "string") continue;
  const quoted = v.match(/"([^"]+)"/);
  if (quoted) add(k.slice(TITLES.length, -"KillTitle_Req".length), quoted[1]);
}
const enemyLeaves = new Set(Object.keys(parents).map((l) => l.toLowerCase()));
for (const [k, v] of Object.entries(dict)) {
  if (!k.startsWith(CHARACTERS)) continue;
  const leaf = k.slice(CHARACTERS.length) + "Avatar";
  if (enemyLeaves.has(leaf.toLowerCase())) add(leaf, v);
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(OUT, `${JSON.stringify({ names: sorted(names), parents: sorted(parents) }, null, 1)}\n`);
console.error(`Wrote ${OUT}: ${Object.keys(names).length} names, ${Object.keys(parents).length} parent links.`);
