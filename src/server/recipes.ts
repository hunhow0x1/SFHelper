import type { CraftDef, RecipeDef } from "../gamedata/builders";
import type { GameTimer } from "./timers";

export interface CraftingState {
  recipes: Record<string, number>;
  stock: Record<string, number>;
  dracs: number;
  bond: Record<string, number>;
  pending: PendingCraft[];
  // Copies held of things that don't stack: Pacts, weapons, armour and palettes
  // (stacked items like Elixirs and Chordstones are in stock). Recipes show it as
  // "Owned", and the Foundry won't forge a Pact you already have ("Already Owned").
  owned: Record<string, number>;
}

export interface PendingCraft {
  id: string | null;
  recipe: string;
  completes: number;
}

type Entry = { ItemType?: unknown; ItemCount?: unknown; Rank?: unknown };

const entries = (v: unknown): Entry[] => (Array.isArray(v) ? v.filter((e): e is Entry => !!e && typeof e === "object") : []);
const ANCESTOR_RE = /\/Ancestors\/(\w+)\/\w+Ancestor$/;

const COPY_LISTS = ["Suits", "Melee", "LongGuns", "Pistols", "WeaponSkins", "FlavourItems"] as const;

function copies(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of COPY_LISTS) {
    for (const e of entries(raw[key])) {
      if (typeof e.ItemType !== "string") continue;
      const n = typeof e.ItemCount === "number" ? e.ItemCount : 1;
      if (n > 0) out[e.ItemType] = (out[e.ItemType] ?? 0) + n;
    }
  }
  return out;
}

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
    owned: copies(raw),
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

// Why a Pact recipe can't be forged even with everything gathered: you already
// own that Pact, or it's curing at the Foundry right now.
export function pactBlock(type: string, r: RecipeDef, c: CraftingState): "owned" | "curing" | null {
  if (r.kind !== "Pacts") return null;
  if ((c.owned?.[r.result] ?? 0) > 0) return "owned";
  return c.pending.some((p) => p.recipe === type) ? "curing" : null;
}

export function recipeTimes(type: string, r: RecipeDef, c: CraftingState): number {
  const fragments = c.recipes[type] ?? 0;
  if (fragments <= 0 || pactBlock(type, r, c)) return 0;
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
  return r.station === "Brewing" ? "brew" : isGear(r) ? "build" : r.kind === "Pacts" ? "forge" : "cast";
}
