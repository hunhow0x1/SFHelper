import { readFile } from "node:fs/promises";
import { appFile } from "./paths";
import { writeFileAtomic } from "./files";

const EXACT_WINDOW_MS = 10 * 60_000;

interface State {
  day: string;
  since: string;
  exact: boolean;
  last: Record<string, number>;
  lastAt: string;
  earned: Record<string, number>;
}

export interface StandingToday {
  since: string;
  exact: boolean;
  total: number;
  factions: Record<string, number>;
}

export interface DailyCaps {
  cap: number;
  remaining: number;
  odeCap: number;
  odeRemaining: number;
  earned: number;
  exact: boolean;
}

const ODE_TAG = "OdeSyndicate";

export function dailyCaps(
  level: number | null,
  reported: { affiliation: number | null; affiliationOde: number | null },
  today: StandingToday | null,
): DailyCaps | null {
  if (reported.affiliation == null && level == null) return null;
  const full = level != null ? 16_000 + 500 * level : 0;
  const trackedOde = today?.factions[ODE_TAG] ?? 0;
  const trackedMain = (today?.total ?? 0) - trackedOde;

  const one = (rem: number | null, tracked: number) => {
    const cap = Math.max(full, rem ?? 0);
    const counted = rem != null && rem < cap;
    const remaining = counted ? rem! : Math.max(0, cap - tracked);
    return { cap, remaining, counted, earned: Math.max(tracked, cap - remaining) };
  };
  const main = one(reported.affiliation, trackedMain);
  const ode = one(reported.affiliationOde, trackedOde);
  return {
    cap: main.cap,
    remaining: main.remaining,
    odeCap: ode.cap,
    odeRemaining: ode.remaining,
    earned: main.earned + ode.earned,
    exact: (today?.exact ?? false) || (main.counted && (ode.counted || trackedOde === 0)),
  };
}

const statePath = () => appFile("standing.json");

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const resetOf = (ms: number): number => Date.parse(`${dayKey(ms)}T00:00:00Z`);

async function load(): Promise<State | null> {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8")) as State;
    return s && typeof s.day === "string" && s.last && s.earned ? s : null;
  } catch {
    return null;
  }
}

async function save(s: State): Promise<void> {
  const path = statePath();
  await writeFileAtomic(path, JSON.stringify(s));
}

export async function recordStanding(current: Record<string, number>, now = Date.now()): Promise<StandingToday> {
  const prev = await load();
  const day = dayKey(now);
  const reset = resetOf(now);
  let s: State;

  if (!prev || prev.day !== day) {
    const lastAt = prev ? Date.parse(prev.lastAt) : NaN;
    const exact = !!prev && lastAt < reset && reset - lastAt <= EXACT_WINDOW_MS;
    const earned: Record<string, number> = {};
    for (const [tag, v] of Object.entries(current)) {
      earned[tag] = exact && prev!.last[tag] !== undefined ? Math.max(0, v - prev!.last[tag]!) : 0;
    }
    s = {
      day,
      since: new Date(exact ? reset : now).toISOString(),
      exact,
      last: { ...(prev?.last ?? {}), ...current },
      lastAt: new Date(now).toISOString(),
      earned,
    };
  } else {
    s = prev;
    for (const [tag, v] of Object.entries(current)) {
      const before = s.last[tag];
      if (before !== undefined && v > before) s.earned[tag] = (s.earned[tag] ?? 0) + (v - before);
      else s.earned[tag] ??= 0;
      s.last[tag] = v;
    }
    s.lastAt = new Date(now).toISOString();
  }

  await save(s);
  const factions: Record<string, number> = {};
  for (const tag of Object.keys(current)) factions[tag] = s.earned[tag] ?? 0;
  return {
    since: s.since,
    exact: s.exact,
    total: Object.values(factions).reduce((a, b) => a + b, 0),
    factions,
  };
}
