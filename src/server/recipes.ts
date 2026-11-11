import type { CraftDef, RecipeDef } from "../gamedata/builders";
import type { GameTimer } from "./timers";

export interface CraftingState {
  recipes: Record<string, number>;
  stock: Record<string, number>;
  dracs: number;
  bond: Record<string, number>;
  pending: PendingCraft[];
}

export interface PendingCraft {
  id: string | null;
  recipe: string;
  completes: number;
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
    pending: parsePendingCrafts(raw.PendingRecipes),
  };
}

export function parsePendingCrafts(list: unknown): PendingCraft[] {
  const out: PendingCraft[] = [];
  for (const e of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
    if (!e || typeof e.ItemType !== "string") continue;
    const raw = (e.CompletionDate as { $date?: { $numberLong?: unknown } } | undefined)?.$date?.$numberLong;
    const completes = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
    if (!Number.isFinite(completes) || completes <= 0) continue;
    const id = (e.ItemId as { $oid?: unknown } | undefined)?.$oid;
    out.push({ id: typeof id === "string" ? id : null, recipe: e.ItemType, completes });
  }
  return out.sort((a, b) => a.completes - b.completes);
}

const KIND_ONE: Record<string, string> = {
  Elixirs: "Elixir",
  "Pup Treats": "Pup Treat",
  Palettes: "Palette",
  Chordstones: "Chordstone",
  Pacts: "Pact",
  Talismans: "Talisman",
};

export function craftKind(d: Pick<CraftDef, "kind" | "slot">): string {
  return d.slot ?? (d.kind ? KIND_ONE[d.kind] ?? "" : "");
}

export function craftTimers(pending: PendingCraft[], defs: Record<string, CraftDef>): GameTimer[] {
  const out: GameTimer[] = [];
  for (const p of pending) {
    const d = defs[p.recipe];
    if (!d) continue;
    out.push({ tag: `Craft-${p.id ?? `${p.recipe}@${p.completes}`}`, kind: craftKind(d) || null, name: d.name, ready: `${d.name} is ready to claim`, expiry: p.completes });
  }
  return out;
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
