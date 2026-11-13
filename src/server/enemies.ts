// Names enemy types from enemies.json: the type's own name, else its parents',
// else the same words in another order (MockeryStoneWomanArmored vs.
// MockeryStoneArmoredWoman), else the name without variant words (Elite, Night).

import { getDataRefreshedAt } from "./importStatus";
import { readDataJson } from "./paths";

export interface EnemyData {
  names: Record<string, string>;
  parents: Record<string, string>;
}

const VARIANT_WORDS = new Set(["Elite", "Night", "Always", "Summon", "Proc", "Swamp", "Messenger", "Old", "Young", "Helmet"]);
const INTERNAL_WORDS = new Set(["Proc", "Always"]);
const MAX_PERMUTED_WORDS = 5;

function viaParents(leaf: string, d: EnemyData): string | null {
  for (let l: string | undefined = leaf, hops = 0; l && hops < 20; l = d.parents[l], hops += 1) {
    const name = d.names[l.toLowerCase()];
    if (name) return name;
  }
  return null;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [x, ...p]));
}

const wordsOf = (leaf: string): string[] => leaf.replace(/Avatar$/, "").match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];

function byLeaf(leaf: string, d: EnemyData, depth: number): string | null {
  const direct = viaParents(leaf, d);
  if (direct) return direct;
  const words = wordsOf(leaf);
  if (words.length > 1 && words.length <= MAX_PERMUTED_WORDS) {
    for (const p of permutations(words)) {
      const name = viaParents(`${p.join("")}Avatar`, d);
      if (name) return name;
    }
  }
  if (depth < 2) {
    for (let i = 0; i < words.length; i += 1) {
      if (!VARIANT_WORDS.has(words[i]!) || words.length === 1) continue;
      const name = byLeaf(`${[...words.slice(0, i), ...words.slice(i + 1)].join("")}Avatar`, d, depth + 1);
      if (name) return name;
    }
  }
  return null;
}

function cleaned(leaf: string): string {
  return wordsOf(leaf).filter((w) => !INTERNAL_WORDS.has(w)).join(" ") || leaf;
}

export function enemyName(type: string, d: EnemyData): string {
  const leaf = type.slice(type.lastIndexOf("/") + 1);
  return byLeaf(leaf, d, 0) ?? cleaned(leaf);
}

export function agentName(agent: string, d: EnemyData): string | null {
  const norm = (leaf: string) => wordsOf(leaf.replace(/Agent$/, "Avatar").replace(/subboss/i, "SubBoss")).map((w) => w.toLowerCase());
  const words = new Set(norm(agent));
  const subBoss = words.has("sub") && words.has("boss");
  let best: { name: string; n: number } | null = null;
  for (const leaf of Object.keys(d.parents)) {
    if (!leaf.endsWith("Avatar")) continue;
    const w = norm(leaf);
    if (!w.length || !w.every((x) => words.has(x)) || (subBoss && !(w.includes("sub") && w.includes("boss")))) continue;
    const name = viaParents(leaf, d);
    if (name && (!best || w.length > best.n)) best = { name, n: w.length };
  }
  return best?.name ?? null;
}

let loaded: { at: number | null; data: Promise<EnemyData> } | null = null;
function enemyData(): Promise<EnemyData> {
  const at = getDataRefreshedAt();
  if (!loaded || loaded.at !== at) {
    loaded = { at, data: readDataJson<EnemyData>("enemies.json").then((d) => d ?? { names: {}, parents: {} }) };
  }
  return loaded.data;
}

export async function getEnemyNamer(): Promise<(type: string) => string> {
  const d = await enemyData();
  return (type) => enemyName(type, d);
}

export async function getAgentNamer(): Promise<(agent: string) => string | null> {
  const d = await enemyData();
  return (agent) => agentName(agent, d);
}
