import type { GameTimer } from "./timers";

export const PET_STATS = ["Guard", "Speed", "Stamina", "Search", "Support"] as const;
export type PetStat = (typeof PET_STATS)[number];

export const PUP_ENERGY_PER_SECOND = 0.008888888888888889;
export const PUP_SUMMON_SHARE = 0.8;
export const PUP_MAX_ENERGY = 100;
export const PUP_REST_TAG = "WolfpupRest";

export interface OwnedPet {
  id: string | null;
  type: string;
  name: string | null;
  temperament: string | null;
  adult: boolean;
  skills: Record<PetStat, number>;
  xp: Record<PetStat, number>;
  bond: number;
  energy: number;
  needsRest: boolean;
  energySavedAt: number | null;
  mealsEaten: number;
  snacksEaten: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function dateMs(v: unknown): number | null {
  const raw = (v as { $date?: { $numberLong?: unknown } } | undefined)?.$date?.$numberLong;
  const ms = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function parsePets(raw: Record<string, unknown>): OwnedPet[] {
  if (!Array.isArray(raw.KubrowPets)) return [];
  const pets: OwnedPet[] = [];
  for (const p of raw.KubrowPets as Record<string, unknown>[]) {
    if (!p || typeof p.ItemType !== "string") continue;
    const d = (p.Details ?? {}) as Record<string, unknown>;
    pets.push({
      id: str((p.ItemId as { $oid?: unknown } | undefined)?.$oid),
      type: p.ItemType,
      name: str(d.Name),
      temperament: str(d.Temperment),
      adult: d.IsAdult === true,
      skills: Object.fromEntries(PET_STATS.map((s) => [s, num(d[`${s}Skill`])])) as Record<PetStat, number>,
      xp: Object.fromEntries(PET_STATS.map((s) => [s, num(d[s])])) as Record<PetStat, number>,
      bond: num(d.Bond),
      energy: num(d.Energy),
      needsRest: d.NeedsRest === true,
      energySavedAt: dateMs(d.RestDate),
      mealsEaten: num(d.MealsEaten),
      snacksEaten: num(d.SnacksEaten),
    });
  }
  return pets;
}

export function pupEnergyAt(p: OwnedPet, now: number, max = PUP_MAX_ENERGY): number {
  const rested = p.energySavedAt ? Math.max(0, now - p.energySavedAt) / 1000 : 0;
  return Math.min(max, p.energy + rested * PUP_ENERGY_PER_SECOND);
}

export function pupSummonableAt(p: OwnedPet, max = PUP_MAX_ENERGY): number | null {
  if (!p.needsRest || !p.energySavedAt) return null;
  return p.energySavedAt + Math.max(0, (PUP_SUMMON_SHARE * max - p.energy) / PUP_ENERGY_PER_SECOND) * 1000;
}

export function pupRestTimers(pets: OwnedPet[], names: Record<string, string> = {}, max = PUP_MAX_ENERGY): GameTimer[] {
  return pets.flatMap((p, i) => {
    const at = pupSummonableAt(p, max);
    if (at === null) return [];
    const name = (p.name && names[p.name]) || "Your Wolfpup";
    return [{ tag: i ? `${PUP_REST_TAG}-${i}` : PUP_REST_TAG, kind: "Wolfpup resting", name, ready: `${name} can be summoned again`, expiry: Math.round(at) }];
  });
}
