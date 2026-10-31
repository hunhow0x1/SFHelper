/** Discoveries: the places (and maps) the game tracks, and the Memories found at
 *  each. Discoveries and Memories count toward Envoy Rank.
 *
 *  The list of locations, their in-game names and Memory counts come from the
 *  game's data (public/locations.json, built by scripts/build_locations.mjs).
 *  What you've found comes from the inventory's LoreFragmentScans: one entry
 *  per location discovered, with Progress = Memories found there.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LOCATION_PREFIX = "/SF/Types/Quests/LocationLoreQuests/";

export interface LoreScan {
  /** Memories found there. */
  progress: number;
  redeemed: boolean;
}

export interface Place {
  key: string;
  name: string;
  /** Memories this place holds (0 for some, like the Undercity's districts). */
  memories: number;
  /** Memories found, at most `memories`. */
  found: number;
  discovered: boolean;
}

export interface Discoveries {
  places: Place[];
  /** Dungeon maps: no Memories, just found or not. */
  maps: { found: number; total: number };
}

/** Location type leaf -> what the inventory says about it. */
export function parseLoreScans(raw: Record<string, unknown>): Record<string, LoreScan> {
  const out: Record<string, LoreScan> = {};
  for (const e of Array.isArray(raw.LoreFragmentScans) ? raw.LoreFragmentScans : []) {
    const s = e as { ItemType?: unknown; Progress?: unknown; Redeemed?: unknown };
    if (typeof s.ItemType !== "string" || !s.ItemType.startsWith(LOCATION_PREFIX)) continue;
    out[s.ItemType.slice(LOCATION_PREFIX.length)] = {
      progress: typeof s.Progress === "number" && s.Progress > 0 ? s.Progress : 0,
      redeemed: s.Redeemed === true,
    };
  }
  return out;
}

type LocationDefs = Record<string, { name: string; memories: number; map: boolean }>;

/** Every known place (found or not, by name) and the maps found, against the game's list. */
export function discoveries(scans: Record<string, LoreScan>, defs: LocationDefs): Discoveries {
  const places: Place[] = [];
  let mapsFound = 0;
  let mapsTotal = 0;
  for (const [key, def] of Object.entries(defs)) {
    const scan = scans[key];
    if (def.map) {
      mapsTotal += 1;
      if (scan) mapsFound += 1;
      continue;
    }
    places.push({ key, name: def.name, memories: def.memories, found: Math.min(def.memories, scan?.progress ?? 0), discovered: !!scan });
  }
  places.sort((a, b) => a.name.localeCompare(b.name));
  return { places, maps: { found: mapsFound, total: mapsTotal } };
}

const HERE = dirname(fileURLToPath(import.meta.url));
let defs: LocationDefs | null = null;

/** The Discoveries view for an inventory's scans; null if the bundled list is missing. */
export async function getDiscoveries(scans: Record<string, LoreScan>): Promise<Discoveries | null> {
  if (!defs) {
    try {
      defs = (JSON.parse(await readFile(join(HERE, "public", "locations.json"), "utf8")) as { locations: LocationDefs }).locations;
    } catch {
      return null;
    }
  }
  return discoveries(scans, defs);
}
