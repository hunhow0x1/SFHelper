import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_PACKAGES_PATH, readTypeTree } from "./type_tree.mjs";
import { readPackageTexts } from "./package_texts.mjs";

const [dictPath = "dict.en.json", pkgPath = DEFAULT_PACKAGES_PATH] = process.argv.slice(2);
const OUT = "src/server/public/locations.json";
const DIR = "/SF/Types/Quests/LocationLoreQuests/";

const dict = JSON.parse(await readFile(dictPath, "utf8"));
const buf = await readFile(pkgPath);
const texts = readPackageTexts(buf);
const types = [...readTypeTree(buf).keys()].filter((p) => p.startsWith(DIR) && !p.slice(DIR.length).includes("/"));

const leafOf = (p) => p.slice(p.lastIndexOf("/") + 1);
const stem = (s) => s.replace(/(Location)?(Map)?LoreFragment$/, "").replace(/Name$/, "").toLowerCase();
const nameKey = (t) => /^Name=(\/SF\/Language\/Locations\/\S+)$/m.exec(t)?.[1];

const votes = new Map();
const typesByStem = new Map();
types.forEach((p, j) => typesByStem.set(stem(leafOf(p)), [...(typesByStem.get(stem(leafOf(p))) ?? []), j]));
texts.forEach((t, f) => {
  const key = nameKey(t);
  for (const j of key ? (typesByStem.get(stem(leafOf(key))) ?? []) : []) votes.set(f - j, (votes.get(f - j) ?? 0) + 1);
});
const [offset, agree = 0] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
if (agree < types.length / 4) throw new Error(`only ${agree} of ${types.length} location types line up with their texts by name`);

const locations = {};
const skipped = [];
for (const [j, path] of types.entries()) {
  const text = texts[j + offset] ?? "";
  const key = nameKey(text);
  const name = key ? dict[key]?.trim() : undefined;
  if (!name || name.startsWith("[PH]")) {
    if (key) skipped.push(leafOf(path));
    continue;
  }
  const memories = (/^Memories=\{\n([\s\S]*?)\n\}/m.exec(text)?.[1] ?? "").split("\n").filter((l) => l.trim()).length;
  locations[leafOf(path)] = { name, memories, map: /MapLoreFragment$/.test(leafOf(path)) };
}

await writeFile(OUT, `${JSON.stringify({ locations }, null, 2)}\n`);
const all = Object.values(locations);
console.log(
  `Wrote ${OUT}: ${all.filter((l) => !l.map).length} places (${all.reduce((n, l) => n + l.memories, 0)} Memories), ` +
    `${all.filter((l) => l.map).length} maps; ${agree} of ${types.length} types matched by name` +
    (skipped.length ? `; left out (unnamed or [PH]): ${skipped.join(", ")}` : "") + ".",
);
