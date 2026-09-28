/** Parse the real getProfileViewingData.php payload into an AccountSnapshot.
 *
 *  Shape confirmed against a live account (build 2026.08.20.11.07):
 *
 *    { Results: [ { AccountId:{$oid}, DisplayName, PlayerLevel,
 *                   Affiliations[], ChallengeProgress[],
 *                   LoadOutInventory:{ Suits, LongGuns, Melee, WeaponSkins,
 *                                      XPInfo[] } } ],
 *      Stats: { Weapons[], Enemies[], <scalars> },
 *      TechProjects, XpComponents }
 *
 *  This is a public, unauthenticated view: the equipped loadout plus every
 *  item the player has earned XP on, plus lifetime stats. It is NOT the owned
 *  inventory - no resource counts, no currencies, no unequipped gear - so the
 *  snapshot it produces is "partial", never "full".
 */

import {
  emptySnapshot,
  type AccountSnapshot,
  type ItemStack,
  type ProgressionEntry,
  type SourceRef,
} from "../snapshot";
import { hashAccountId } from "../identity";

/** DE stores masterable item progress under these loadout keys. */
const LOADOUT_ITEM_KEYS = ["Suits", "LongGuns", "Melee", "WeaponSkins"] as const;

interface ProfileEnvelope {
  Results?: ProfileResult[];
  Stats?: Record<string, unknown>;
}

interface ProfileResult {
  AccountId?: { $oid?: string };
  DisplayName?: string;
  PlayerLevel?: number;
  Affiliations?: Array<{ Tag?: string; Standing?: number; Title?: number }>;
  ChallengeProgress?: Array<{ Name?: string; Progress?: number }>;
  LoadOutInventory?: Record<string, unknown>;
  DailyAffiliation?: number;
  DailyAffiliationOde?: number;
}

/** Standing earned today toward the daily caps; both reset at 00:00 UTC. */
export interface DailyStanding {
  affiliation: number | null;
  affiliationOde: number | null;
}

/** A game path's last segment is a usable display name until we have a real
 *  item DB: "/SF/Weapons/Melee/OneHand/FeySword/FeySwordMeleeWeapon" -> FeySword. */
function nameFromItemType(itemType: string): string {
  const parts = itemType.split("/").filter(Boolean);
  return parts[parts.length - 2] ?? parts[parts.length - 1] ?? itemType;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function categoryForKey(key: string): string {
  if (key === "Suits") return "soul";
  if (key === "WeaponSkins") return "cosmetic";
  return "weapon";
}

/** Every item the profile mentions, folded into one list keyed by ItemType.
 *  Equipped items carry their config XP; XPInfo backfills the rest. */
function readItems(loadout: Record<string, unknown>, source: SourceRef): ItemStack[] {
  const byKey = new Map<string, ItemStack>();

  const add = (itemType: string, category: string, rank?: number): void => {
    const existing = byKey.get(itemType);
    if (existing) {
      if (rank !== undefined && (existing.rank === undefined || rank > existing.rank)) {
        existing.rank = rank;
      }
      return;
    }
    const item: ItemStack = {
      key: itemType,
      displayName: nameFromItemType(itemType),
      count: 1,
      category,
      source,
    };
    if (rank !== undefined) item.rank = rank;
    byKey.set(itemType, item);
  };

  for (const key of LOADOUT_ITEM_KEYS) {
    const entries = loadout[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const itemType = record.ItemType;
      if (typeof itemType !== "string") continue;
      add(itemType, categoryForKey(key), num(record.XP));
    }
  }

  const xpInfo = loadout.XPInfo;
  if (Array.isArray(xpInfo)) {
    for (const entry of xpInfo) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const itemType = record.ItemType;
      if (typeof itemType !== "string") continue;
      add(itemType, "earned", num(record.XP));
    }
  }

  return [...byKey.values()];
}

function readProgression(result: ProfileResult, source: SourceRef): ProgressionEntry[] {
  const entries: ProgressionEntry[] = [];

  for (const aff of result.Affiliations ?? []) {
    if (!aff.Tag) continue;
    const entry: ProgressionEntry = {
      key: `affiliation:${aff.Tag}`,
      displayName: aff.Tag.replace(/Syndicate$/, ""),
      kind: "affiliation",
      source,
    };
    const standing = num(aff.Standing);
    const title = num(aff.Title);
    if (standing !== undefined) entry.xp = standing;
    if (title !== undefined) entry.rank = title;
    entries.push(entry);
  }

  for (const ch of result.ChallengeProgress ?? []) {
    if (!ch.Name) continue;
    const entry: ProgressionEntry = {
      key: `challenge:${ch.Name}`,
      displayName: ch.Name,
      kind: "challenge",
      source,
    };
    const progress = num(ch.Progress);
    if (progress !== undefined) entry.xp = progress;
    entries.push(entry);
  }

  return entries;
}

/** Lifetime stats plus per-weapon and per-enemy breakdowns. Kept under raw so
 *  a stats view can read them without inventing schema in the snapshot type. */
export interface ProfileStats {
  scalars: Record<string, number>;
  weapons: Array<Record<string, unknown>>;
  enemies: Array<Record<string, unknown>>;
}

function readStats(stats: Record<string, unknown> | undefined): ProfileStats {
  const scalars: Record<string, number> = {};
  let weapons: Array<Record<string, unknown>> = [];
  let enemies: Array<Record<string, unknown>> = [];
  for (const [key, value] of Object.entries(stats ?? {})) {
    if (key === "Weapons" && Array.isArray(value)) weapons = value as Array<Record<string, unknown>>;
    else if (key === "Enemies" && Array.isArray(value)) enemies = value as Array<Record<string, unknown>>;
    else {
      const n = num(value);
      if (n !== undefined) scalars[key] = n;
    }
  }
  return { scalars, weapons, enemies };
}

export interface ProfileSnapshot extends AccountSnapshot {
  stats: ProfileStats;
  daily: DailyStanding;
}

export function snapshotFromProfile(payload: unknown, observedAt: string): ProfileSnapshot {
  const source: SourceRef = { providerId: "public-web", fidelity: "partial", observedAt };
  const base = emptySnapshot();
  const envelope = (payload ?? {}) as ProfileEnvelope;
  const result = envelope.Results?.[0] ?? {};

  base.sources = [source];
  base.raw = payload;
  base.account.displayName = result.DisplayName ?? null;
  base.account.accountIdHash = hashAccountId(result.AccountId?.$oid ?? null);

  const level = num(result.PlayerLevel);
  if (level !== undefined) base.currencies.PlayerLevel = level;

  base.items = readItems(result.LoadOutInventory ?? {}, source);
  base.progression = readProgression(result, source);

  const daily: DailyStanding = {
    affiliation: num(result.DailyAffiliation) ?? null,
    affiliationOde: num(result.DailyAffiliationOde) ?? null,
  };
  return { ...base, stats: readStats(envelope.Stats), daily };
}
