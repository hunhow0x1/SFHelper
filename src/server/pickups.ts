/** Picked-up weapon history via inventory diff.
 *
 *  Every weapon instance has a stable ItemId. We persist the set of ids we've
 *  seen; on each import, any id not in that set is a newly acquired weapon. The
 *  first run seeds the known set from the existing inventory (those are not
 *  "pickups"), so only weapons acquired from then on are recorded.
 *
 *  Not every new weapon was picked up off the ground, so each one is classified
 *  by what else changed since the previous import:
 *    - crafted:   its blueprint's fragment count (Recipes) dropped or vanished,
 *                 or its blueprint was in the crafting queue (PendingRecipes);
 *    - purchased: a vendor's NumPurchased went up (one weapon per purchase);
 *    - pickup:    anything else.
 *  Only "pickup" entries belong in the Picked-up Weapons list.
 *
 *  Moonsteel is the game's "Shiny" item flag; see moonsteelOf() in weapons.ts.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AcquisitionContext, WeaponInstance } from "./weapons";

export type PickupSource = "pickup" | "crafted" | "purchased";

export interface Pickup extends WeaponInstance {
  /** ISO time the weapon was first seen in the inventory. */
  at: string;
  /** How it was acquired (absent on entries recorded before classification). */
  source?: PickupSource;
}

interface State {
  seeded: boolean;
  known: Record<string, true>;
  history: Pickup[];
  /** The previous import's acquisition context, to diff against. */
  last?: AcquisitionContext | undefined;
}

/** Called once for each newly acquired Moonsteel weapon (any source), after
 *  it has been recorded. The desktop app hooks this to raise a notification. */
type MoonsteelListener = (p: Pickup) => void;
const moonsteelListeners = new Set<MoonsteelListener>();
export function onMoonsteelAcquired(fn: MoonsteelListener): () => void {
  moonsteelListeners.add(fn);
  return () => moonsteelListeners.delete(fn);
}

const BASE = process.env.SFHELPER_HOME ?? join(homedir(), ".config", "sfhelper");
const STATE_PATH = join(BASE, "pickups.json");
const MAX_HISTORY = 1000;

async function load(): Promise<State> {
  try {
    const s = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<State>;
    return {
      seeded: s.seeded === true,
      known: s.known ?? {},
      history: Array.isArray(s.history) ? s.history : [],
      last: s.last,
    };
  } catch {
    return { seeded: false, known: {}, history: [] };
  }
}

async function save(s: State): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(s));
}

/** Weapon/blueprint leaf -> comparable base name ("CorruptedScimitar"). */
const baseName = (leaf: string): string =>
  leaf
    .split("/").pop()!
    .replace(/Blueprint$/, "")
    .replace(/(RangedMeleeWeapon|MeleeWeapon|RangedWeapon|Weapon)$/, "")
    .toLowerCase();

/** The blueprint leaf (if any) that crafts this weapon. Exact base-name match
 *  first; otherwise allow a trailing-"s" difference (SphereDualSword(s)). */
function blueprintFor(weaponKey: string, blueprints: string[]): string | null {
  const w = baseName(weaponKey);
  const exact = blueprints.find((b) => baseName(b) === w);
  if (exact) return exact;
  return blueprints.find((b) => {
    const bb = baseName(b);
    return (w.startsWith(bb) || bb.startsWith(w)) && Math.abs(w.length - bb.length) <= 1;
  }) ?? null;
}

/** Diff the current instances against what we've seen; record new ones. Returns
 *  the full history (newest first), every source included. */
export async function recordPickups(instances: WeaponInstance[], ctx: AcquisitionContext): Promise<Pickup[]> {
  const s = await load();
  if (!s.seeded) {
    for (const w of instances) s.known[w.id] = true;
    s.seeded = true;
    s.last = ctx;
    await save(s);
    return s.history;
  }
  const prev = s.last;
  const now = new Date().toISOString();
  let changed = false;
  const moonsteel: Pickup[] = [];
  let purchasesLeft = prev ? Math.max(0, ctx.vendorPurchases - prev.vendorPurchases) : 0;
  const bpNames = [...new Set([...Object.keys(ctx.blueprints), ...Object.keys(prev?.blueprints ?? {}), ...(prev?.pending ?? [])])];

  for (const w of instances) {
    if (!w.id || s.known[w.id]) continue;
    s.known[w.id] = true;
    let source: PickupSource = "pickup";
    const bp = blueprintFor(w.key, bpNames);
    if (bp && prev) {
      const before = prev.blueprints[bp] ?? 0;
      const after = ctx.blueprints[bp] ?? 0;
      const wasQueued = prev.pending.includes(bp) && !ctx.pending.includes(bp);
      if (after < before || wasQueued) source = "crafted";
    }
    if (source === "pickup" && purchasesLeft > 0) {
      source = "purchased";
      purchasesLeft--;
    }
    const entry: Pickup = { ...w, at: now, source };
    s.history.unshift(entry);
    if (entry.moonsteel) moonsteel.push(entry);
    changed = true;
  }
  // Always roll the context forward so the next diff compares adjacent imports.
  const ctxChanged = JSON.stringify(prev) !== JSON.stringify(ctx);
  s.last = ctx;
  if (changed) s.history = s.history.slice(0, MAX_HISTORY);
  if (changed || ctxChanged) await save(s);
  // Notify only after the record is saved, so a restart can't re-announce it.
  for (const p of moonsteel) {
    for (const fn of moonsteelListeners) {
      try { fn(p); } catch { /* a listener failure must not break tracking */ }
    }
  }
  return s.history;
}
