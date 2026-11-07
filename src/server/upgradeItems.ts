export interface OwnedRune {
  type: string;
  ranks: number[];
  unranked: number;
}

export interface OwnedJoinery {
  type: string;
  count: number;
}

export interface OwnedGear {
  type: string;
  count: number;
  equipped: boolean;
}

export interface UpgradeItems {
  runes: OwnedRune[];
  joineries: OwnedJoinery[];
  gear: OwnedGear[];
}

type Entry = { ItemType?: unknown; ItemCount?: unknown; UpgradeFingerprint?: unknown };

const entries = (v: unknown): Entry[] => (Array.isArray(v) ? v.filter((e): e is Entry => !!e && typeof e === "object") : []);
const count = (e: Entry): number => (typeof e.ItemCount === "number" && e.ItemCount > 0 ? e.ItemCount : 0);
const isRune = (t: string) => t.startsWith("/SF/Upgrades/Runes/");
const isJoinery = (t: string) => t.startsWith("/SF/Types/Items/Kintsugi/");
const UNRELEASED_GEAR = new Set(["CloudSwellElixer", "LesserChampionVirtueElixir", "LesserFeyVirtueElixir", "LesserSilentRoseVirtueElixir"]);
export const isGear = (t: string) => !t.endsWith("Summon") && !UNRELEASED_GEAR.has(t.slice(t.lastIndexOf("/") + 1));

function rankOf(fingerprint: unknown): number {
  if (typeof fingerprint !== "string") return 0;
  try {
    const lvl = (JSON.parse(fingerprint) as { lvl?: unknown }).lvl;
    return typeof lvl === "number" && lvl >= 0 ? lvl : 0;
  } catch {
    return 0;
  }
}

export function parseUpgradeItems(raw: Record<string, unknown>): UpgradeItems {
  const runes = new Map<string, OwnedRune>();
  const rune = (type: string) => runes.get(type) ?? runes.set(type, { type, ranks: [], unranked: 0 }).get(type)!;
  for (const e of entries(raw.Upgrades)) {
    if (typeof e.ItemType === "string" && isRune(e.ItemType)) rune(e.ItemType).ranks.push(rankOf(e.UpgradeFingerprint));
  }

  const joineries = new Map<string, number>();
  for (const e of entries(raw.RawUpgrades)) {
    if (typeof e.ItemType !== "string" || !count(e)) continue;
    if (isRune(e.ItemType)) rune(e.ItemType).unranked += count(e);
    else if (isJoinery(e.ItemType)) joineries.set(e.ItemType, (joineries.get(e.ItemType) ?? 0) + count(e));
  }

  const equipped = new Set(Array.isArray(raw.EquippedGear) ? raw.EquippedGear.filter((g): g is string => typeof g === "string") : []);
  const gear = new Map<string, number>();
  for (const e of entries(raw.Consumables)) {
    if (typeof e.ItemType === "string" && count(e) && isGear(e.ItemType)) gear.set(e.ItemType, (gear.get(e.ItemType) ?? 0) + count(e));
  }
  for (const type of equipped) if (!gear.has(type) && isGear(type)) gear.set(type, 0);

  return {
    runes: [...runes.values()].map((r) => ({ ...r, ranks: r.ranks.sort((a, b) => b - a) })),
    joineries: [...joineries].map(([type, n]) => ({ type, count: n })),
    gear: [...gear].map(([type, n]) => ({ type, count: n, equipped: equipped.has(type) })),
  };
}
