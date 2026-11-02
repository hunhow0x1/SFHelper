import { readFile } from "node:fs/promises";
import { loggedAgari } from "./gameLog";
import { getAgentNamer } from "./enemies";
import { appFile } from "./paths";
import { writeFileAtomic } from "./files";

export interface GameTimer {
  tag: string;
  kind: string | null;
  name: string;
  ready: string;
  spot?: string;
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

const ORGAN_REGIONS: Record<string, string> = { Airdelands: "Fuirlands", Kearnhold: "Kearnhold Lowlands", Odell: "Fortress O'Dell" };

const KNOWN: [RegExp, (m: RegExpExecArray) => Label][] = [
  [/^UPGRADEGIVEN_GODANDGHOST$/, () => ({ kind: "Once a day, after a boon", name: "Blessed Meeting", ready: "Blessed Meetings can happen again" })],
  [/^(.+)-SubBoss$/i, (m) => {
    const place = words(m[1]!);
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

export function nameAgari(
  timers: GameTimer[],
  spawned: Record<string, string>,
  agentName: (agent: string) => string | null,
): GameTimer[] {
  return timers.map((t) => {
    const agent = t.spot ? spawned[t.spot] : undefined;
    const name = agent && /sub ?boss/i.test(agent) ? agentName(agent) : null;
    return name ? { ...t, name, ready: `${name} can return` } : t;
  });
}

const agariPath = () => appFile("agari.json");
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

export function resetRememberedAgari(): void {
  savedAgari = null;
}

export async function withAgariNames(timers: GameTimer[]): Promise<GameTimer[]> {
  if (!timers.some((t) => t.spot)) return timers;
  const [spawned, agentName] = await Promise.all([loggedAgari().then(rememberedAgari), getAgentNamer()]);
  return nameAgari(timers, spawned, agentName);
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
