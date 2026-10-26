/** Envoy Rank (the game's Mastery Rank): the exact rank, the patch's maximum,
 *  and an ESTIMATE of progress toward the next rank.
 *
 *  The rank itself is exact (PlayerLevel). Progress isn't: the game shows only
 *  a filling badge, sends no Mastery total, and its Mastery values aren't
 *  published. So we model it:
 *   - Item Mastery, in weapon-rank units: each weapon rank earned (from the
 *     XPInfo mastery record) is 1, each pact rank PACT_WEIGHT. Histories and
 *     discoveries also grant Mastery but have no known values; left out.
 *   - Cumulative Mastery for rank r grows as K * r^EXPONENT, with K set so that
 *     every weapon and pact at rank 30 lands on the wiki's patch maximum.
 *  PACT_WEIGHT and EXPONENT fit what's observable, with K the same across
 *  patches: the wiki's Preludes 13 screenshots (one maxed pact, the Fey, lifted
 *  the max from ~17.9 to ~18.15), the Preludes 16 max of ~19.1, and a rank-17
 *  account with all pacts and ~70% of weapon ranks whose badge is about a third
 *  full. Rough, so once SFHelper sees the rank go up it anchors that rank's
 *  start at the item Mastery seen then (stored per account).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appFile, dataDir } from "./paths";
import { MAX_RANK as MAX_ITEM_RANK, PACT_RANK_CONST, xpToRank } from "./weapons";

const PACT_WEIGHT = 2.5;
const EXPONENT = 2.3;

export interface EnvoyRank {
  /** Current Envoy Rank (exact). */
  rank: number;
  /** The wiki's maximum Mastery this patch (e.g. 19.1), and the patch ("P16"). */
  maxMastery: number | null;
  patch: string | null;
  /** Highest whole rank reachable this patch (floor of maxMastery). */
  maxRank: number | null;
  /** Estimated 0..1 progress toward rank + 1; null at the patch's top rank. */
  progress: number | null;
  /** True once the current rank's start is anchored by an observed rank-up. */
  calibrated: boolean;
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
  /** Item Mastery observed when the current rank was reached, if seen. */
  anchor?: number | undefined;
}

/** Weapon and pact ranks earned, and the item Mastery they add up to. */
export function itemMastery(mastery: Record<string, number>): { weaponRanks: number; pactRanks: number; units: number } {
  let weaponRanks = 0;
  let pactRanks = 0;
  for (const [type, xp] of Object.entries(mastery)) {
    if (type.startsWith("/SF/Weapons/")) weaponRanks += xpToRank(xp);
    else if (type.startsWith("/SF/Souls/")) pactRanks += xpToRank(xp, PACT_RANK_CONST);
  }
  return { weaponRanks, pactRanks, units: weaponRanks + PACT_WEIGHT * pactRanks };
}

/** The estimate itself (pure; the stored anchor comes in through `anchor`). */
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
  if (!i.maxMastery || (maxRank !== null && i.rank >= maxRank)) return { ...base, progress: null, calibrated: false };

  const allUnits = items.weaponMax + PACT_WEIGHT * items.pactMax;
  const k = allUnits / i.maxMastery ** EXPONENT;
  const at = (r: number) => k * r ** EXPONENT;
  // An observed rank-up pins where this rank started; shift the curve to it.
  const shift = i.anchor !== undefined ? i.anchor - at(i.rank) : 0;
  const lo = at(i.rank) + shift;
  const hi = at(i.rank + 1) + shift;
  // The rank is known exactly, so the estimate stays inside it.
  const progress = Math.min(0.99, Math.max(0, (earned.units - lo) / (hi - lo)));
  return { ...base, progress, calibrated: i.anchor !== undefined };
}

// --- per-account rank-up anchors ---------------------------------------------

/** Bumped when item Mastery is counted differently (v2: weapons on their own
 *  250 * r^2 curve), so units stored by an older version are ignored. */
const STATE_VERSION = 2;

interface AnchorState {
  v?: number;
  /** Last observation, to spot a rank-up between two imports. */
  last?: { rank: number; units: number };
  /** Rank -> item Mastery when it was reached. */
  anchors: Record<string, number>;
}

const statePath = (accountId: string) => appFile(`envoy-rank-${accountId}.json`);

async function loadState(accountId: string): Promise<AnchorState> {
  try {
    const s = JSON.parse(await readFile(statePath(accountId), "utf8")) as AnchorState;
    return s && s.v === STATE_VERSION && typeof s.anchors === "object" ? s : { anchors: {} };
  } catch {
    return { anchors: {} };
  }
}

/** Record this observation; on a one-rank rise, anchor the new rank midway
 *  between the item Mastery before and after (imports are minutes apart). */
export function observe(state: AnchorState, rank: number, units: number): AnchorState {
  const next: AnchorState = { v: STATE_VERSION, anchors: { ...state.anchors }, last: { rank, units } };
  if (state.last && rank === state.last.rank + 1 && units >= state.last.units) {
    next.anchors[String(rank)] = (state.last.units + units) / 2;
  }
  return next;
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
 *  mastery record (no inventory) there's no estimate: just rank and maximum. */
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
    return { rank, maxMastery, patch, maxRank: maxMastery ? Math.floor(maxMastery) : null, progress: null, calibrated: false, items: null };
  }
  const units = itemMastery(mastery).units;
  const state = observe(await loadState(accountId), rank, units);
  try {
    await mkdir(dirname(statePath(accountId)), { recursive: true });
    await writeFile(statePath(accountId), JSON.stringify(state));
  } catch {
    // Calibration is a nicety; the estimate works without it.
  }
  return estimateEnvoyRank({
    rank,
    mastery,
    weaponCount: weapons ? Object.keys(weapons).length : 0,
    pactCount: pacts ? Object.keys(pacts).length : 0,
    maxMastery,
    patch,
    anchor: state.anchors[String(rank)],
  });
}
