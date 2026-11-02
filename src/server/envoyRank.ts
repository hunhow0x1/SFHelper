import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appFile, dataDir } from "./paths";
import { loggedMastery } from "./gameLog";
import { MAX_RANK as MAX_ITEM_RANK, PACT_RANK_CONST, xpToRank } from "./weapons";
import { writeFileAtomic } from "./files";

const WEAPON_RANK_XP = 100;
const PACT_RANK_XP = 200;
const RANK_XP = 1250;

export const rankStart = (rank: number): number => RANK_XP * rank * rank;

export interface EnvoyRank {
  rank: number;
  maxMastery: number | null;
  patch: string | null;
  maxRank: number | null;
  progress: number | null;
  mastery: { total: number; items: number; other: number; next: number } | null;
  items: { weaponRanks: number; weaponMax: number; pactRanks: number; pactMax: number } | null;
}

export interface MasteryInputs {
  rank: number;
  mastery: Record<string, number>;
  weaponCount: number;
  pactCount: number;
  maxMastery: number | null;
  patch: string | null;
  other?: number | null;
}

export function itemMastery(mastery: Record<string, number>): { weaponRanks: number; pactRanks: number; xp: number } {
  let weaponRanks = 0;
  let pactRanks = 0;
  for (const [type, xp] of Object.entries(mastery)) {
    if (type.startsWith("/SF/Weapons/")) weaponRanks += xpToRank(xp);
    else if (type.startsWith("/SF/Souls/")) pactRanks += xpToRank(xp, PACT_RANK_CONST);
  }
  return { weaponRanks, pactRanks, xp: weaponRanks * WEAPON_RANK_XP + pactRanks * PACT_RANK_XP };
}

export function estimateEnvoyRank(i: MasteryInputs): EnvoyRank {
  const earned = itemMastery(i.mastery);
  const weaponCount = Math.max(i.weaponCount, Object.keys(i.mastery).filter((t) => t.startsWith("/SF/Weapons/")).length);
  const pactCount = Math.max(i.pactCount, Object.keys(i.mastery).filter((t) => t.startsWith("/SF/Souls/")).length);
  const items = {
    weaponRanks: earned.weaponRanks,
    weaponMax: weaponCount * MAX_ITEM_RANK,
    pactRanks: earned.pactRanks,
    pactMax: pactCount * MAX_ITEM_RANK,
  };
  const maxRank = i.maxMastery ? Math.floor(i.maxMastery) : null;
  const base = { rank: i.rank, maxMastery: i.maxMastery, patch: i.patch, maxRank, items };
  if (i.other == null) return { ...base, progress: null, mastery: null };

  const total = earned.xp + i.other;
  const next = rankStart(i.rank + 1);
  const mastery = { total, items: earned.xp, other: i.other, next };
  if (maxRank !== null && i.rank >= maxRank) return { ...base, progress: null, mastery };
  const start = rankStart(i.rank);
  const progress = total >= start ? Math.min(0.99, (total - start) / (next - start)) : null;
  return { ...base, progress, mastery };
}

const STATE_VERSION = 3;

interface MasteryState {
  v: number;
  other: number;
}

const statePath = (accountId: string) => appFile(`envoy-rank-${accountId}.json`);

async function loadOther(accountId: string): Promise<number | null> {
  try {
    const s = JSON.parse(await readFile(statePath(accountId), "utf8")) as Partial<MasteryState>;
    return s.v === STATE_VERSION && typeof s.other === "number" ? s.other : null;
  } catch {
    return null;
  }
}

async function saveOther(accountId: string, other: number): Promise<void> {
  try {
    await writeFileAtomic(statePath(accountId), JSON.stringify({ v: STATE_VERSION, other } satisfies MasteryState));
  } catch {
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));

async function readData<T>(name: string): Promise<T | null> {
  const overlay = dataDir();
  for (const dir of [overlay, join(HERE, "public")]) {
    if (!dir) continue;
    try {
      return JSON.parse(await readFile(join(dir, name), "utf8")) as T;
    } catch {
    }
  }
  return null;
}

export async function getEnvoyRank(
  accountId: string,
  rank: number,
  mastery: Record<string, number> | null,
): Promise<EnvoyRank> {
  const [max, weapons, pacts] = await Promise.all([
    readData<{ maxMastery?: number; patch?: string }>("masteryrank.json"),
    readData<Record<string, unknown>>("weapons.json"),
    readData<Record<string, unknown>>("pacts.json"),
  ]);
  const maxMastery = typeof max?.maxMastery === "number" ? max.maxMastery : null;
  const patch = typeof max?.patch === "string" ? max.patch : null;
  if (!mastery) {
    return { rank, maxMastery, patch, maxRank: maxMastery ? Math.floor(maxMastery) : null, progress: null, mastery: null, items: null };
  }
  const logged = await loggedMastery();
  const saved = await loadOther(accountId);
  if (logged && logged.other !== saved) await saveOther(accountId, logged.other);
  return estimateEnvoyRank({
    rank,
    mastery,
    weaponCount: weapons ? Object.keys(weapons).length : 0,
    pactCount: pacts ? Object.keys(pacts).length : 0,
    maxMastery,
    patch,
    other: logged?.other ?? saved,
  });
}
