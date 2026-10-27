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
 *    - purchased: a vendor's NumPurchased went up (one weapon per purchase), or
 *                 Favour was spent at an Enclave (up to one weapon per 1,000
 *                 spent, the cheapest weapon offering);
 *    - traded:    the trade tracker saw it arrive in a trade (see trades.ts);
 *    - pickup:    anything else.
 *  Only "pickup" entries belong in the Picked-up Weapons list.
 *
 *  Moonsteel is the game's "Shiny" item flag; see moonsteelOf() in weapons.ts.
 *
 *  `at` is when the import noticed the weapon, which trails the real pickup by
 *  the game's sync delay. `when` is the real time: from the game log when the
 *  pickup is in the current session's log, else the server time in the ItemId.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AcquisitionContext, WeaponInstance } from "./weapons";
import { logPickupTimes, objectIdTime } from "./gameLog";
import { appFile } from "./paths";

export type PickupSource = "pickup" | "crafted" | "purchased" | "traded";

export interface Pickup extends WeaponInstance {
  /** ISO time the weapon was first seen in the inventory. */
  at: string;
  /** ISO time it was actually acquired (see whenSource). */
  when?: string;
  /** Where `when` came from: the game log (exact), the ItemId's server
   *  timestamp (when the game synced it), or neither (falls back to `at`). */
  whenSource?: "log" | "server" | "import";
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

const statePath = () => appFile("pickups.json");
const MAX_HISTORY = 1000;

async function load(): Promise<State> {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8")) as Partial<State>;
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
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(s));
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

/** Fill in `when` for entries that have not been timed yet (new ones, and
 *  entries recorded before timing existed). Each entry is resolved once: the
 *  log already holds a pickup by the time the server has the weapon. */
async function resolveTimes(history: Pickup[]): Promise<boolean> {
  const pending = history.filter((p) => !p.whenSource);
  if (!pending.length) return false;
  // Log events already assigned to earlier entries must not be reused.
  const taken = new Map<string, Set<number>>();
  for (const p of history) {
    if (p.whenSource !== "log" || !p.when) continue;
    const leaf = p.key.split("/").pop()!;
    if (!taken.has(leaf)) taken.set(leaf, new Set());
    taken.get(leaf)!.add(Date.parse(p.when));
  }
  let fromLog = new Map<string, number>();
  try {
    fromLog = await logPickupTimes(pending.filter((p) => p.id).map((p) => ({ id: p.id!, key: p.key })), taken);
  } catch {
    // The log is a bonus; never let it break pickup tracking.
  }
  for (const p of pending) {
    const logged = p.id ? fromLog.get(p.id) : undefined;
    const synced = objectIdTime(p.id);
    if (logged !== undefined) {
      p.when = new Date(logged).toISOString();
      p.whenSource = "log";
    } else if (synced !== null) {
      p.when = new Date(synced).toISOString();
      p.whenSource = "server";
    } else {
      p.when = p.at;
      p.whenSource = "import";
    }
  }
  return true;
}

// Page requests and the desktop app's imports both diff, and can overlap; run
// one at a time so a new weapon is recorded (and announced) once.
let queue: Promise<unknown> = Promise.resolve();

/** Diff the current instances against what we've seen; record new ones. Returns
 *  the full history (newest first), every source included. */
export function recordPickups(
  instances: WeaponInstance[],
  ctx: AcquisitionContext,
  traded: Set<string> = new Set(),
): Promise<Pickup[]> {
  const run = queue.then(() => record(instances, ctx, traded));
  queue = run.catch(() => undefined);
  return run;
}

async function record(instances: WeaponInstance[], ctx: AcquisitionContext, traded: Set<string>): Promise<Pickup[]> {
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
  // Enclave weapons are bought with Favour and never show up in the vendor
  // purchase history, so a Favour drop is the tell.
  let favourSpent = 0;
  if (prev?.favour && ctx.favour) {
    for (const [tag, v] of Object.entries(ctx.favour)) {
      const before = prev.favour[tag];
      if (before !== undefined && v < before) favourSpent += before - v;
    }
  }
  let enclaveLeft = Math.floor(favourSpent / 1000);
  const bpNames = [...new Set([...Object.keys(ctx.blueprints), ...Object.keys(prev?.blueprints ?? {}), ...(prev?.pending ?? [])])];

  for (const w of instances) {
    if (!w.id || s.known[w.id]) continue;
    s.known[w.id] = true;
    let source: PickupSource = traded.has(w.id) ? "traded" : "pickup";
    const bp = blueprintFor(w.key, bpNames);
    if (source === "pickup" && bp && prev) {
      const before = prev.blueprints[bp] ?? 0;
      const after = ctx.blueprints[bp] ?? 0;
      const wasQueued = prev.pending.includes(bp) && !ctx.pending.includes(bp);
      if (after < before || wasQueued) source = "crafted";
    }
    if (source === "pickup" && purchasesLeft > 0) {
      source = "purchased";
      purchasesLeft--;
    } else if (source === "pickup" && enclaveLeft > 0) {
      source = "purchased";
      enclaveLeft--;
    }
    const entry: Pickup = { ...w, at: now, source };
    s.history.unshift(entry);
    if (entry.moonsteel) moonsteel.push(entry);
    changed = true;
  }
  if (await resolveTimes(s.history)) changed = true;
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
