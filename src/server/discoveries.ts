import { getDataRefreshedAt } from "./importStatus";
import { readDataJson } from "./paths";

const LOCATION_PREFIX = "/SF/Types/Quests/LocationLoreQuests/";

export interface LoreScan {
  progress: number;
  redeemed: boolean;
}

export interface Place {
  key: string;
  name: string;
  memories: number;
  found: number;
  discovered: boolean;
  region: string | null;
  dungeon: string | null;
}

export interface Discoveries {
  places: Place[];
  maps: { found: number; total: number };
}

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

type LocationDefs = Record<string, { name: string; memories: number; map: boolean; region?: string; dungeon?: string }>;

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
    places.push({
      key,
      name: def.name,
      memories: def.memories,
      found: Math.min(def.memories, scan?.progress ?? 0),
      discovered: !!scan,
      region: typeof def.region === "string" ? def.region : null,
      dungeon: typeof def.dungeon === "string" ? def.dungeon : null,
    });
  }
  places.sort((a, b) => a.name.localeCompare(b.name));
  return { places, maps: { found: mapsFound, total: mapsTotal } };
}

let defs: { at: number | null; locations: LocationDefs } | null = null;

export async function getDiscoveries(scans: Record<string, LoreScan>): Promise<Discoveries | null> {
  const at = getDataRefreshedAt();
  if (!defs || defs.at !== at) {
    const locations = (await readDataJson<{ locations?: LocationDefs }>("locations.json"))?.locations;
    if (!locations) return null;
    defs = { at, locations };
  }
  return discoveries(scans, defs.locations);
}
