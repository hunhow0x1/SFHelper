export interface CollectorSite {
  region: string;
  x: number;
  z: number;
}

export const COLLECTOR_SITES: CollectorSite[] = [
  { region: "Fortress O'Dell", x: 866, z: -18 },
  { region: "Fuirlands", x: 491, z: 948 },
  { region: "Kearnhold Lowlands", x: 551, z: -943 },
  { region: "Fuirlands", x: 803, z: 1156 },
  { region: "Airde Limbwoods", x: 234, z: 387 },
  { region: "Fuirlands", x: 1000, z: 736 },
  { region: "Fuirlands", x: 659, z: 472 },
  { region: "Fortress O'Dell", x: 611, z: -525 },
  { region: "Kearnhold Lowlands", x: 205, z: -1322 },
  { region: "Kearnhold Lowlands", x: 124, z: -1258 },
];

const NEAR_M = 150;

export function collectorRegion(x: number, z: number): string | null {
  let best: { site: CollectorSite; d: number } | null = null;
  for (const site of COLLECTOR_SITES) {
    const d = Math.hypot(site.x - x, site.z - z);
    if (!best || d < best.d) best = { site, d };
  }
  return best && best.d <= NEAR_M ? best.site.region : null;
}
