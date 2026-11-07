import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../src/server/files";
import { agentName, type EnemyData } from "../src/server/enemies";
import { AGARI_SPOTS, agariPath, mergeAgariSpots } from "../src/server/timers";

const PUBLIC_DIR = "src/server/public";

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const learned = await readJson<Record<string, string>>(agariPath());
if (!learned) {
  console.error(`Nothing learned yet: ${agariPath()} is missing. Run SFHelper while Agari spawn in the game first.`);
  process.exit(1);
}
const bundledPath = join(PUBLIC_DIR, AGARI_SPOTS);
const { spots, added } = mergeAgariSpots((await readJson<Record<string, string>>(bundledPath)) ?? {}, learned);
if (!added.length) {
  console.log(`No new Agari spots; ${Object.keys(spots).length} already listed.`);
  process.exit(0);
}
await writeFileAtomic(bundledPath, `${JSON.stringify(spots, null, 2)}\n`);
const enemies = (await readJson<EnemyData>(join(PUBLIC_DIR, "enemies.json"))) ?? { names: {}, parents: {} };
for (const spot of added) console.log(`${spot}: ${agentName(spots[spot]!, enemies) ?? `${spots[spot]} (no name in enemies.json yet)`}`);
console.log(`Added ${added.length} Agari spot${added.length === 1 ? "" : "s"} to ${bundledPath}.`);
