/** Owned weapons with their affinity (XP), parsed from a raw inventory dump.
 *
 *  The profile/inventory stores per-weapon XP (affinity), not a rank. Weapons
 *  level 0-30; on DE's Evolution engine the cumulative affinity to reach rank r
 *  is 500 * r^2 (450,000 at rank 30, after which affinity keeps accruing). The
 *  dashboard turns XP into a rank and a progress bar with the same formula.
 */

const RANK_CONST = 500;
export const MAX_RANK = 30;

export interface OwnedWeapon {
  /** ItemType, resolved to a display name by the dashboard. */
  key: string;
  /** Total affinity earned (can exceed the rank-30 threshold). */
  xp: number;
  /** Which inventory bucket it came from. */
  slot: "Melee" | "LongGuns" | "Pistols";
}

/** Cumulative affinity needed to reach a given rank. */
export function affinityForRank(rank: number): number {
  return RANK_CONST * rank * rank;
}

/** Rank 0-30 for a total-affinity value. */
export function xpToRank(xp: number): number {
  if (!(xp > 0)) return 0;
  return Math.max(0, Math.min(MAX_RANK, Math.floor(Math.sqrt(xp / RANK_CONST))));
}

/** A Pact (Soul). Pacts level 0-30 like weapons but on the slower "frame" curve
 *  (cumulative affinity = 1000 * r^2), consistent with the wiki noting Pacts take
 *  longer to level than weapons. */
export const PACT_RANK_CONST = 1000;
export interface OwnedPact {
  key: string;
  xp: number;
}

export function parsePacts(raw: unknown): OwnedPact[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>).Suits; // souls live under Suits
  if (!Array.isArray(list)) return [];
  const byKey = new Map<string, OwnedPact>();
  for (const entry of list) {
    const e = entry as { ItemType?: string; XP?: unknown };
    if (typeof e.ItemType !== "string") continue;
    const xp = typeof e.XP === "number" && Number.isFinite(e.XP) ? e.XP : 0;
    const prev = byKey.get(e.ItemType);
    if (!prev || xp > prev.xp) byKey.set(e.ItemType, { key: e.ItemType, xp });
  }
  return [...byKey.values()];
}

const WEAPON_BUCKETS: OwnedWeapon["slot"][] = ["Melee", "LongGuns", "Pistols"];

export function parseWeapons(raw: unknown): OwnedWeapon[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const byKey = new Map<string, OwnedWeapon>();
  for (const slot of WEAPON_BUCKETS) {
    const list = record[slot];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = entry as { ItemType?: string; XP?: unknown };
      if (typeof e.ItemType !== "string") continue;
      const xp = typeof e.XP === "number" && Number.isFinite(e.XP) ? e.XP : 0;
      // Keep the highest-XP copy if the same weapon appears more than once.
      const prev = byKey.get(e.ItemType);
      if (!prev || xp > prev.xp) byKey.set(e.ItemType, { key: e.ItemType, xp, slot });
    }
  }
  return [...byKey.values()];
}
