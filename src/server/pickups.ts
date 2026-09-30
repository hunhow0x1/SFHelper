/** Picked-up weapon history via inventory diff.
 *
 *  Every weapon instance has a stable ItemId. We persist the set of ids we've
 *  seen; on each import, any id not in that set is a newly acquired weapon, which
 *  we append to a history with its craftwork + tempers + timestamp. The first
 *  run seeds the known set from the existing inventory (those are not "pickups"),
 *  so only weapons acquired from then on are recorded.
 *
 *  Moonsteel is a client-only cosmetic and is not present in the inventory data,
 *  so it cannot be recorded here.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WeaponInstance } from "./weapons";

export interface Pickup extends WeaponInstance {
  /** ISO time the weapon was first seen in the inventory. */
  at: string;
}

interface State {
  seeded: boolean;
  known: Record<string, true>;
  history: Pickup[];
}

const BASE = process.env.SFHELPER_HOME ?? join(homedir(), ".config", "sfhelper");
const STATE_PATH = join(BASE, "pickups.json");
const MAX_HISTORY = 1000;

async function load(): Promise<State> {
  try {
    const s = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<State>;
    return { seeded: s.seeded === true, known: s.known ?? {}, history: Array.isArray(s.history) ? s.history : [] };
  } catch {
    return { seeded: false, known: {}, history: [] };
  }
}

async function save(s: State): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(s));
}

/** Diff the current instances against what we've seen; record new ones. Returns
 *  the full pickup history (newest first). */
export async function recordPickups(instances: WeaponInstance[]): Promise<Pickup[]> {
  const s = await load();
  if (!s.seeded) {
    for (const w of instances) s.known[w.id] = true;
    s.seeded = true;
    await save(s);
    return s.history;
  }
  const now = new Date().toISOString();
  let changed = false;
  for (const w of instances) {
    if (!w.id || s.known[w.id]) continue;
    s.known[w.id] = true;
    s.history.unshift({ ...w, at: now });
    changed = true;
  }
  if (changed) {
    s.history = s.history.slice(0, MAX_HISTORY);
    await save(s);
  }
  return s.history;
}
