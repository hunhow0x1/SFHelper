/** Envoy Rank (the game's Mastery Rank): the exact rank, the patch's maximum,
 *  and progress toward the next rank.
 *
 *  The rank itself is PlayerLevel. For progress, the game adds up Mastery from
 *  two parts and logs both at login (EE.log):
 *   - "Player has N (item based) XP": 100 per weapon rank and 200 per Pact rank
 *     earned (from the XPInfo mastery record). SFHelper computes this itself.
 *   - "Total calculated MissionProgressXP is N": discoveries, histories and the
 *     like. Only the log has it, so SFHelper keeps the last value it saw.
 *  Rank r starts at RANK_XP * r^2 Mastery. That fits what the game shows: a
 *  rank-17 account at 375,400 (195,400 + 180,000) has its badge a third full
 *  (17.33), and everything maxed in Preludes 16 comes to about the wiki's 19.1.
 *  Without the log's part there's no progress figure.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appFile, dataDir } from "./paths";
import { loggedMastery } from "./gameLog";
import { MAX_RANK as MAX_ITEM_RANK, PACT_RANK_CONST, xpToRank } from "./weapons";

/** Mastery per weapon rank and per Pact rank. */
const WEAPON_RANK_XP = 100;
const PACT_RANK_XP = 200;
/** Envoy Rank r starts at RANK_XP * r^2 Mastery. */
const RANK_XP = 1250;

export const rankStart = (rank: number): number => RANK_XP * rank * rank;

export interface EnvoyRank {
  /** Current Envoy Rank (exact). */
  rank: number;
  /** The wiki's maximum Mastery this patch (e.g. 19.1), and the patch ("P16"). */
  maxMastery: number | null;
  patch: string | null;
  /** Highest whole rank reachable this patch (floor of maxMastery). */
  maxRank: number | null;
  /** 0..1 progress toward rank + 1; null at the patch's top rank, or without the game log's part. */
  progress: number | null;
  /** Mastery so far (items + everything else) and where the next rank starts; null without the log's part. */
  mastery: { total: number; items: number; other: number; next: number } | null;
  /** Weapon and pact ranks earned, out of everything available (null without an inventory). */
  items: { weaponRanks: number; weaponMax: number; pactRanks: number; pactMax: number } | null;
}

export interface MasteryInputs {
  rank: number;
  /** XPInfo: ItemType -> most XP ever reached. */
  mastery: Record<string, number>;
  /** How many weapons and pacts exist (the rosters). */
  weaponCount: number;
  pactCount: number;
  maxMastery: number | null;
  patch: string | null;
  /** Mastery from outside item ranks (the log's MissionProgressXP), if known. */
  other?: number | null;
}

/** Weapon and pact ranks earned, and the Mastery they add up to. */
export function itemMastery(mastery: Record<string, number>): { weaponRanks: number; pactRanks: number; xp: number } {
  let weaponRanks = 0;
  let pactRanks = 0;
  for (const [type, xp] of Object.entries(mastery)) {
    if (type.startsWith("/SF/Weapons/")) weaponRanks += xpToRank(xp);
    else if (type.startsWith("/SF/Souls/")) pactRanks += xpToRank(xp, PACT_RANK_CONST);
  }
  return { weaponRanks, pactRanks, xp: weaponRanks * WEAPON_RANK_XP + pactRanks * PACT_RANK_XP };
}

/** The tracker's figures (pure; the log's part comes in through `other`). */
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
  // The rank is exact, so a total below its start means the log's part is out
  // of date: show no figure rather than a wrong one. Past the next rank's start
  // (ranked up since the last import) it stays just short of full.
  const progress = total >= start ? Math.min(0.99, (total - start) / (next - start)) : null;
  return { ...base, progress, mastery };
}

// --- the log's part, kept per account ------------------------------------------

/** v3: the log's MissionProgressXP. (v1-v2 held rank-up anchors for the old estimate.) */
const STATE_VERSION = 3;

interface MasteryState {
  v: number;
  /** The last MissionProgressXP seen in the game log. */
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
    await mkdir(dirname(statePath(accountId)), { recursive: true });
    await writeFile(statePath(accountId), JSON.stringify({ v: STATE_VERSION, other } satisfies MasteryState));
  } catch {
    // Only matters once the game log is gone; the next login logs it again.
  }
}

// --- data files ----------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

/** A data file from the launch-refreshed overlay, else the bundled copy. */
async function readData<T>(name: string): Promise<T | null> {
  const overlay = dataDir();
  for (const dir of [overlay, join(HERE, "public")]) {
    if (!dir) continue;
    try {
      return JSON.parse(await readFile(join(dir, name), "utf8")) as T;
    } catch {
      // try the next location
    }
  }
  return null;
}

/** Everything the Mastery tab's tracker needs, for one account. Without a
 *  mastery record (no inventory) there's no progress: just rank and maximum. */
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
