import { readFile } from "node:fs/promises";
import { appFile, readDataJson } from "./paths";
import { loggedMastery } from "./gameLog";
import { MAX_RANK as MAX_ITEM_RANK, PACT_RANK_CONST, xpToRank } from "./weapons";
import { writeFileAtomic } from "./files";
import { getRoster } from "./roster";
import { getDiscoveries, type LoreScan } from "./discoveries";

const WEAPON_RANK_XP = 100;
const PACT_RANK_XP = 200;
const HISTORY_XP = 5000;
const RANK_XP = 1250;

export const rankStart = (rank: number): number => RANK_XP * rank * rank;

export function rankFor(total: number): number {
  let rank = Math.floor(Math.sqrt(Math.max(0, total) / RANK_XP));
  while (rankStart(rank + 1) <= total) rank++;
  while (rank > 0 && rankStart(rank) > total) rank--;
  return rank;
}

export interface MasteryMax {
  rank: number;
  exact: number;
  items: number;
  history: number;
  places: number;
}

export interface EnvoyRank {
  rank: number;
  serverRank: number;
  patch: string | null;
  maxRank: number | null;
  max: MasteryMax | null;
  progress: number | null;
  mastery: { total: number; items: number; other: number; next: number } | null;
  items: { weaponRanks: number; weaponMax: number; pactRanks: number; pactMax: number } | null;
}

export interface MasteryInputs {
  rank: number;
  mastery: Record<string, number>;
  weaponCount: number;
  pactCount: number;
  patch: string | null;
  places: number;
  completed?: number | null;
  other?: number | null;
  loggedItems?: number | null;
}

const rankAt = (total: number): number => {
  const r = rankFor(total);
  return Math.floor((r + (total - rankStart(r)) / (rankStart(r + 1) - rankStart(r))) * 10 + 1e-6) / 10;
};

export function masteryMax(weapons: number, pacts: number, places: number, other: number | null = null, completed: number | null = null): MasteryMax | null {
  if (!weapons || !places) return null;
  const items = (weapons * WEAPON_RANK_XP + pacts * PACT_RANK_XP) * MAX_ITEM_RANK;
  const extra = other !== null && completed !== null ? Math.max(0, other - completed * HISTORY_XP) : 0;
  const history = Math.max(places * HISTORY_XP + extra, other ?? 0);
  return { rank: rankFor(items + history), exact: rankAt(items + history), items, history, places };
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
  const completed = i.completed ?? null;
  const fromHistory = completed !== null ? completed * HISTORY_XP : null;
  const other = i.other == null ? fromHistory : fromHistory === null ? i.other : Math.max(i.other, fromHistory);
  const max = masteryMax(weaponCount, pactCount, i.places, other, completed);
  const maxRank = max?.rank ?? null;
  const base = { rank: i.rank, serverRank: i.rank, patch: i.patch, maxRank, max, items };
  if (other === null) return { ...base, progress: null, mastery: null };

  const itemXp = Math.max(earned.xp, i.loggedItems ?? 0);
  const total = itemXp + other;
  const rank = rankFor(total);
  const next = rankStart(rank + 1);
  const mastery = { total, items: itemXp, other, next };
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

export async function getEnvoyRank(
  accountId: string,
  rank: number,
  mastery: Record<string, number> | null,
  loreScans: Record<string, LoreScan> | null = null,
): Promise<EnvoyRank> {
  const [roster, arsenal, found] = await Promise.all([
    getRoster(),
    readDataJson<{ patch?: string }>("arsenal.json"),
    getDiscoveries(loreScans ?? {}),
  ]);
  const patch = typeof arsenal?.patch === "string" ? arsenal.patch : null;
  const history = (found?.places ?? []).filter((p) => p.memories > 0);
  const completed = loreScans ? history.filter((p) => p.found >= p.memories).length : null;
  const weaponCount = Object.keys(roster.weapons).length;
  const pactCount = Object.keys(roster.pacts).length;
  if (!mastery) {
    const max = masteryMax(weaponCount, pactCount, history.length);
    return { rank, serverRank: rank, patch, maxRank: max?.rank ?? null, max, progress: null, mastery: null, items: null };
  }
  const logged = await loggedMastery();
  const saved = await loadOther(accountId);
  if (logged && logged.other !== saved) await saveOther(accountId, logged.other);
  return estimateEnvoyRank({
    rank,
    mastery,
    weaponCount,
    pactCount,
    patch,
    places: history.length,
    completed,
    other: logged?.other ?? saved,
    loggedItems: logged?.items ?? null,
  });
}
