/** In-game names for the enemy types in the profile's kill stats.
 *
 *  Stats key enemies by type path (/SF/Types/Enemies/Sinecure/Soldier/
 *  MeleeGruntAvatar); the game shows a localized name ("Sinecure Soldier").
 *  public/enemies.json (built by scripts/build_enemies.mjs from the game's
 *  localization and type tree) holds the names by type leaf, plus each enemy
 *  type's parent. A type without a name of its own takes its nearest
 *  ancestor's, as in game: MeleeGruntSpikedMaceEliteAvatar -> MeleeGruntAvatar.
 *
 *  Stats also keep types from older game builds that no longer exist under
 *  that name, so as fallbacks we try the leaf's words reordered (old
 *  EliteMeleeGruntAvatar = current MeleeGruntEliteAvatar), then without
 *  variant words like "Elite"; failing all that, a cleaned-up leaf.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface EnemyData {
  /** Type leaf, lowercased -> in-game name. */
  names: Record<string, string>;
  /** Type leaf -> parent type leaf. */
  parents: Record<string, string>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(HERE, "public", "enemies.json");

/** Words that mark a variant of an enemy (or a boss phase), not a different one. */
const VARIANT_WORDS = new Set(["Elite", "Night", "Always", "Summon", "Proc", "Swamp", "Messenger", "Old", "Young", "Helmet"]);
/** Internal markers left out of a fallback name. */
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

/** "MendicantKnightProcAvatar" -> "Mendicant Knight". */
function cleaned(leaf: string): string {
  return wordsOf(leaf).filter((w) => !INTERNAL_WORDS.has(w)).join(" ") || leaf;
}

/** The in-game name for an enemy type path. */
export function enemyName(type: string, d: EnemyData): string {
  const leaf = type.slice(type.lastIndexOf("/") + 1);
  return byLeaf(leaf, d, 0) ?? cleaned(leaf);
}

let loaded: Promise<EnemyData> | null = null;

/** Name lookup backed by the bundled data (a no-name fallback if it's missing). */
export async function getEnemyNamer(): Promise<(type: string) => string> {
  loaded ??= readFile(DATA_PATH, "utf8")
    .then((t) => JSON.parse(t) as EnemyData)
    .catch(() => ({ names: {}, parents: {} }));
  const d = await loaded;
  return (type) => enemyName(type, d);
}
