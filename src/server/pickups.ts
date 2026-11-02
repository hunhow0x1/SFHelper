import { readFile } from "node:fs/promises";
import type { AcquisitionContext, WeaponInstance } from "./weapons";
import { logPickupTimes, objectIdTime } from "./gameLog";
import { appFile } from "./paths";
import { writeFileAtomic } from "./files";

export type PickupSource = "pickup" | "crafted" | "purchased" | "traded";

export interface Pickup extends WeaponInstance {
  at: string;
  when?: string;
  whenSource?: "log" | "server" | "import";
  source?: PickupSource;
}

interface State {
  seeded: boolean;
  known: Record<string, true>;
  history: Pickup[];
  last?: AcquisitionContext | undefined;
}

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
  await writeFileAtomic(path, JSON.stringify(s));
}

const baseName = (leaf: string): string =>
  leaf
    .split("/").pop()!
    .replace(/Blueprint$/, "")
    .replace(/(RangedMeleeWeapon|MeleeWeapon|RangedWeapon|Weapon)$/, "")
    .toLowerCase();

function blueprintFor(weaponKey: string, blueprints: string[]): string | null {
  const w = baseName(weaponKey);
  const exact = blueprints.find((b) => baseName(b) === w);
  if (exact) return exact;
  return blueprints.find((b) => {
    const bb = baseName(b);
    return (w.startsWith(bb) || bb.startsWith(w)) && Math.abs(w.length - bb.length) <= 1;
  }) ?? null;
}

async function resolveTimes(history: Pickup[]): Promise<boolean> {
  const pending = history.filter((p) => !p.whenSource);
  if (!pending.length) return false;
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

let queue: Promise<unknown> = Promise.resolve();

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
  const ctxChanged = JSON.stringify(prev) !== JSON.stringify(ctx);
  s.last = ctx;
  if (changed) s.history = s.history.slice(0, MAX_HISTORY);
  if (changed || ctxChanged) await save(s);
  for (const p of moonsteel) {
    for (const fn of moonsteelListeners) {
      try { fn(p); } catch {}
    }
  }
  return s.history;
}
