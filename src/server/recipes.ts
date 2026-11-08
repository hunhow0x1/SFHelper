import type { RecipeDef } from "../gamedata/builders";

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

const RECIPE_NPC: Record<string, string> = { Brewing: "Verminia", Blacksmith: "Tuvalkane" };
const isGear = (r: RecipeDef): boolean => r.kind === "Weapons" || r.kind === "Armour";

export function recipeTimes(type: string, r: RecipeDef, c: CraftingState): number {
  const fragments = c.recipes[type] ?? 0;
  if (fragments <= 0) return 0;
  const bond = c.bond[RECIPE_NPC[r.station] ?? ""];
  if (!isGear(r) && r.bond != null && bond != null && bond < r.bond) return 0;
  const have = (i: RecipeDef["ingredients"][number]) => (c.stock[i.type] ?? 0) + (i.alt ?? []).reduce((n, a) => n + (c.stock[a] ?? 0), 0);
  const limits = r.ingredients.map((i) => Math.floor(have(i) / i.count));
  if (r.dracs > 0) limits.push(Math.floor(c.dracs / r.dracs));
  limits.push(r.consumed ? Math.floor(fragments / r.fragments) : fragments >= r.fragments ? Infinity : 0);
  return Math.max(0, Math.min(...limits));
}

export function readyRecipes(defs: Record<string, RecipeDef>, c: CraftingState): Set<string> {
  return new Set(Object.entries(defs).filter(([type, r]) => recipeTimes(type, r, c) > 0).map(([type]) => type));
}

export function newlyReady(before: Set<string> | null, now: Set<string>, watch: string[]): string[] {
  return before ? watch.filter((type) => now.has(type) && !before.has(type)) : [];
}

export function recipeVerb(r: RecipeDef): string {
  return r.station === "Brewing" ? "brew" : isGear(r) ? "build" : "cast";
}
