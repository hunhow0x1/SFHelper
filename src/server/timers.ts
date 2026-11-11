import { readFile } from "node:fs/promises";
import { loggedAgari, type LoggedBlessed, type LoggedCollector } from "./gameLog";
import { collectorRegion } from "./collector";
import { getAgentNamer } from "./enemies";
import { appFile, readDataJson } from "./paths";
import { writeFileAtomic } from "./files";

export interface GameTimer {
  tag: string;
  kind: string | null;
  name: string;
  ready: string;
  spot?: string;
  docked?: { at: number; region: string | null; started: number | null; leaves: number | null };
  expiry: number;
}

function words(s: string): string {
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]+$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(" ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
}

type Label = Omit<GameTimer, "tag" | "expiry">;

export const COLLECTOR_TAG = "CollectorTimer";
const COLLECTOR_STALE_MS = 10 * 60_000;
const COLLECTOR_STAY_MS = 15 * 60_000;
const COLLECTOR_FIGHT_MS = 30 * 60_000;
const BLESSED_SETTLE_MS = 2_000;
const BLESSED_FRESH_MS = 5 * 60_000;

const ORGAN_REGIONS: Record<string, string> = { Airdelands: "Fuirlands", Kearnhold: "Kearnhold Lowlands", ODell: "O'Dell", Odell: "O'Dell" };

const KNOWN: [RegExp, (m: RegExpExecArray) => Label][] = [
  [/^UPGRADEGIVEN_GODANDGHOST$/, () => ({ kind: "Once a day, after a boon", name: "Blessed Meeting", ready: "Blessed Meetings can happen again" })],
  [new RegExp(`^${COLLECTOR_TAG}$`), () => ({ kind: "Operation cooldown", name: "Collector Event", ready: "The Collector Event can happen again" })],
  [/^PumpkinRider$/, () => ({ kind: "Event boss cooldown", name: "Veltruska", ready: "Veltruska can emerge again" })],
  [/^WolfpupRest(-\d+)?$/, () => ({ kind: "Wolfpup resting", name: "Wolfpup", ready: "Your Wolfpup can be summoned again" })],
  [/^(.+)-SubBoss$/i, (m) => {
    const place = words(m[1]!.replace(/-/g, " "));
    return { kind: "Agari respawn", name: place, ready: `The Agari at ${place} can return`, spot: m[1]! };
  }],
  [/^([A-Z][A-Za-z]*?)Siege$/, (m) => {
    const name = `${words(m[1]!)} Siege`;
    return { kind: "Siege cooldown", name, ready: `The ${name} can start again` };
  }],
  [/^PollutionTower([A-Za-z]+)$/, (m) => {
    const name = `${ORGAN_REGIONS[m[1]!] ?? words(m[1]!)} Organ`;
    return { kind: "Organ cooldown", name, ready: `The ${name} can be destroyed again` };
  }],
];

export function timerLabel(tag: string): Label {
  for (const [re, label] of KNOWN) {
    const m = re.exec(tag);
    if (m) return label(m);
  }
  const name = words(tag.replace(/-/g, " "));
  return { kind: null, name, ready: `${name} is over` };
}

const AGARI_PLACES: Record<string, string> = { MendicantKingA: "Stroaic" };
const isAgari = (agent: string): boolean => /sub ?boss|MendicantKing/i.test(agent);

export function dungeonName(folder: string, dungeons: Record<string, string>): string | null {
  const f = folder.toLowerCase();
  for (const [stem, name] of Object.entries(dungeons)) {
    const s = stem.toLowerCase();
    if (f === s || f.startsWith(s) || s.endsWith(f)) return name;
  }
  return null;
}

export function nameAgari(
  timers: GameTimer[],
  spawned: Record<string, string>,
  agentName: (agent: string) => string | null,
  dungeons: Record<string, string> = {},
): GameTimer[] {
  return timers.map((t) => {
    const learned = t.spot ? spawned[t.spot] : undefined;
    if (!learned) return t;
    const slash = learned.lastIndexOf("/");
    const agent = learned.slice(slash + 1);
    const boss = isAgari(agent) ? agentName(agent) : null;
    if (!boss) return t;
    const place = slash > 0 ? dungeonName(learned.slice(0, slash), dungeons) : AGARI_PLACES[t.spot!] ?? null;
    const name = place ? `${boss} - ${place}` : boss;
    return { ...t, name, ready: `${name} can return` };
  });
}

export const AGARI_SPOTS = "agari-spots.json";
export const agariPath = () => appFile("agari.json");
let savedAgari: Record<string, string> | null = null;

export async function rememberedAgari(logged: Record<string, string>): Promise<Record<string, string>> {
  if (!savedAgari) {
    try {
      const raw = JSON.parse(await readFile(agariPath(), "utf8")) as unknown;
      savedAgari = raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"))
        : {};
    } catch {
      savedAgari = {};
    }
  }
  if (Object.entries(logged).every(([spot, agent]) => savedAgari![spot] === agent)) return savedAgari;
  savedAgari = { ...savedAgari, ...logged };
  try {
    await writeFileAtomic(agariPath(), JSON.stringify(savedAgari));
  } catch {}
  return savedAgari;
}

export function mergeAgariSpots(known: Record<string, string>, learned: Record<string, string>): { spots: Record<string, string>; added: string[] } {
  const spots = { ...known };
  const added: string[] = [];
  for (const [spot, agent] of Object.entries(learned)) {
    if (spot.startsWith("Dungeon-") || !isAgari(agent) || spots[spot] === agent) continue;
    spots[spot] = agent;
    added.push(spot);
  }
  return { spots: Object.fromEntries(Object.entries(spots).sort(([a], [b]) => a.localeCompare(b))), added: added.sort() };
}

export function resetRememberedAgari(): void {
  savedAgari = null;
}

export async function withAgariNames(timers: GameTimer[]): Promise<GameTimer[]> {
  const spawned = await loggedAgari().then(rememberedAgari);
  if (!timers.some((t) => t.spot)) return timers;
  const [known, agentName, places] = await Promise.all([
    readDataJson<Record<string, string>>(AGARI_SPOTS),
    getAgentNamer(),
    readDataJson<{ dungeons?: Record<string, string> }>("locations.json"),
  ]);
  return nameAgari(timers, { ...known, ...spawned }, agentName, places?.dungeons ?? {});
}

export function dockedCollector(c: LoggedCollector | null, now = Date.now()): GameTimer["docked"] | null {
  if (!c || c.ended !== null || now - c.logAt > COLLECTOR_STALE_MS) return null;
  const leaves = c.started === null ? c.at + COLLECTOR_STAY_MS : null;
  if (leaves !== null ? now >= leaves : now - c.started! > COLLECTOR_FIGHT_MS) return null;
  return { at: c.at, region: c.x !== null && c.z !== null ? collectorRegion(c.x, c.z) : null, started: c.started, leaves };
}

export function blessedMeetingNear(b: LoggedBlessed | null, now = Date.now()): boolean {
  return !!b && b.ended === null && now - b.at >= BLESSED_SETTLE_MS && now - b.at <= BLESSED_FRESH_MS;
}

export function withCollector(timers: GameTimer[], c: LoggedCollector | null, now = Date.now()): GameTimer[] {
  const docked = dockedCollector(c, now);
  if (!docked) return timers;
  const rest = timers.filter((t) => t.tag !== COLLECTOR_TAG);
  const own = timers.find((t) => t.tag === COLLECTOR_TAG) ?? { tag: COLLECTOR_TAG, ...timerLabel(COLLECTOR_TAG), expiry: 0 };
  return [{ ...own, docked }, ...rest];
}

export function withStarred(timers: GameTimer[], watch: string[]): GameTimer[] {
  const have = new Set(timers.map((t) => t.tag));
  return [...timers, ...watch.filter((tag) => !have.has(tag)).map((tag) => ({ tag, ...timerLabel(tag), expiry: 0 }))];
}

export class TimerAlarms {
  private pending = new Map<string, GameTimer>();

  set(timers: GameTimer[], now = Date.now()): void {
    const keep = new Set<string>();
    for (const t of timers) {
      if (t.expiry <= now) continue;
      const key = `${t.tag}@${t.expiry}`;
      keep.add(key);
      this.pending.set(key, t);
    }
    for (const [key, t] of this.pending) if (!keep.has(key) && t.expiry > now) this.pending.delete(key);
  }

  due(now = Date.now()): GameTimer[] {
    const out: GameTimer[] = [];
    for (const [key, t] of this.pending) {
      if (t.expiry > now) continue;
      out.push(t);
      this.pending.delete(key);
    }
    return out;
  }
}

export function parseTimers(raw: Record<string, unknown>): GameTimer[] {
  const out: GameTimer[] = [];
  for (const e of Array.isArray(raw.ExpiryTimeTrackers) ? raw.ExpiryTimeTrackers : []) {
    const t = e as { Tag?: unknown; ExpiryTime?: unknown; AutoExpire?: unknown };
    if (typeof t.Tag !== "string" || typeof t.ExpiryTime !== "number" || t.AutoExpire !== true) continue;
    out.push({ tag: t.Tag, ...timerLabel(t.Tag), expiry: t.ExpiryTime * 1000 });
  }
  return out.sort((a, b) => a.expiry - b.expiry);
}
