export const PET_STATS = ["Guard", "Speed", "Stamina", "Search", "Support"] as const;
export type PetStat = (typeof PET_STATS)[number];

export interface OwnedPet {
  id: string | null;
  type: string;
  name: string | null;
  temperament: string | null;
  adult: boolean;
  skills: Record<PetStat, number>;
  xp: Record<PetStat, number>;
  bond: number;
  needsRest: boolean;
  restUntil: number | null;
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
      needsRest: d.NeedsRest === true,
      restUntil: dateMs(d.RestDate),
      mealsEaten: num(d.MealsEaten),
      snacksEaten: num(d.SnacksEaten),
    });
  }
  return pets;
}
