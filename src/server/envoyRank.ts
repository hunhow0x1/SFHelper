import { readFile } from "node:fs/promises";
import { appFile, readDataJson } from "./paths";
import { loggedMastery } from "./gameLog";
import { MAX_RANK as MAX_ITEM_RANK, PACT_RANK_CONST, xpToRank } from "./weapons";
import { writeFileAtomic } from "./files";
import { getRoster } from "./roster";

const WEAPON_RANK_XP = 100;
const PACT_RANK_XP = 200;
const RANK_XP = 1250;

export const rankStart = (rank: number): number => RANK_XP * rank * rank;

export function rankFor(total: number): number {
  let rank = Math.floor(Math.sqrt(Math.max(0, total) / RANK_XP));
  while (rankStart(rank + 1) <= total) rank++;
  while (rank > 0 && rankStart(rank) > total) rank--;
  return rank;
}

export interface EnvoyRank {
  rank: number;
  serverRank: number;
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
  loggedItems?: number | null;
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
  const base = { rank: i.rank, serverRank: i.rank, maxMastery: i.maxMastery, patch: i.patch, maxRank, items };
  if (i.other == null) return { ...base, progress: null, mastery: null };

  const itemXp = Math.max(earned.xp, i.loggedItems ?? 0);
  const total = itemXp + i.other;
  const rank = rankFor(total);
  const next = rankStart(rank + 1);
  const mastery = { total, items: itemXp, other: i.other, next };
  if (maxRank !== null && rank >= maxRank) return { ...base, rank, progress: null, mastery };
  const start = rankStart(rank);
  return { ...base, rank, progress: Math.min(0.99, (total - start) / (next - start)), mastery };
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

export async function gameLevel(accountId: string | null | undefined, serverLevel: number | null, mastery: Record<string, number> | null): Promise<number | null> {
  if (serverLevel == null || !mastery) return serverLevel;
  const logged = await loggedMastery();
  const other = logged?.other ?? (accountId ? await loadOther(accountId) : null);
  if (other == null) return serverLevel;
  return Math.min(serverLevel, rankFor(Math.max(itemMastery(mastery).xp, logged?.items ?? 0) + other));
}

export async function getEnvoyRank(
  accountId: string,
  rank: number,
  mastery: Record<string, number> | null,
): Promise<EnvoyRank> {
  const [max, roster] = await Promise.all([
    readDataJson<{ maxMastery?: number; patch?: string }>("masteryrank.json"),
    getRoster(),
  ]);
  const maxMastery = typeof max?.maxMastery === "number" ? max.maxMastery : null;
  const patch = typeof max?.patch === "string" ? max.patch : null;
  if (!mastery) {
    return { rank, serverRank: rank, maxMastery, patch, maxRank: maxMastery ? Math.floor(maxMastery) : null, progress: null, mastery: null, items: null };
  }
  const logged = await loggedMastery();
  const saved = await loadOther(accountId);
  if (logged && logged.other !== saved) await saveOther(accountId, logged.other);
  return estimateEnvoyRank({
    rank,
    mastery,
    weaponCount: Object.keys(roster.weapons).length,
    pactCount: Object.keys(roster.pacts).length,
    maxMastery,
    patch,
    other: logged?.other ?? saved,
    loggedItems: logged?.items ?? null,
  });
}
