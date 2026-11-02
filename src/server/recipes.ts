export interface CraftingState {
  recipes: Record<string, number>;
  stock: Record<string, number>;
  dracs: number;
  bond: Record<string, number>;
}

type Entry = { ItemType?: unknown; ItemCount?: unknown; Rank?: unknown };

const entries = (v: unknown): Entry[] => (Array.isArray(v) ? v.filter((e): e is Entry => !!e && typeof e === "object") : []);
const ANCESTOR_RE = /\/Ancestors\/(\w+)\/\w+Ancestor$/;

function counts(list: unknown, into: Record<string, number> = {}): Record<string, number> {
  for (const e of entries(list)) {
    if (typeof e.ItemType === "string" && typeof e.ItemCount === "number" && e.ItemCount > 0) {
      into[e.ItemType] = (into[e.ItemType] ?? 0) + e.ItemCount;
    }
  }
  return into;
}

export function parseCrafting(raw: Record<string, unknown>): CraftingState {
  const bond: Record<string, number> = {};
  for (const e of entries(raw.Ancestors)) {
    const name = typeof e.ItemType === "string" ? ANCESTOR_RE.exec(e.ItemType)?.[1] : undefined;
    if (name && typeof e.Rank === "number" && e.Rank >= 0) bond[name] = e.Rank + 1;
  }
  return {
    recipes: counts(raw.Recipes),
    stock: counts(raw.Consumables, counts(raw.MiscItems)),
    dracs: typeof raw.RegularCredits === "number" ? raw.RegularCredits : 0,
    bond,
  };
}
