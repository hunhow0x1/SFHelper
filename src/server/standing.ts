/** Faction standing earned since the last daily reset (00:00 UTC).
 *
 *  The profile only carries each faction's cumulative Standing. (Its
 *  DailyAffiliation field is the daily cap still available, not what was
 *  earned, and it isn't per faction.) So we watch Standing over time: every
 *  rise between two observations is standing earned, and the tally restarts at
 *  each reset. Summing rises rather than diffing against a baseline keeps a
 *  standing spend from cancelling out what was earned.
 *
 *  If SFHelper was running across the reset, the last pre-reset observation is
 *  a near-exact baseline. Otherwise anything earned today before SFHelper
 *  started can't be known, and the tally counts from the first observation
 *  (`exact: false`, `since` = that time).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A pre-reset observation this close to the reset counts as an exact baseline
 *  (the dashboard refreshes every 30s while open). */
const EXACT_WINDOW_MS = 10 * 60_000;

interface State {
  /** UTC day ("YYYY-MM-DD") the tally belongs to. */
  day: string;
  /** When counting started: the reset itself if exact, else the first observation. */
  since: string;
  exact: boolean;
  /** Last observed Standing per faction tag, and when. */
  last: Record<string, number>;
  lastAt: string;
  /** Standing earned today per faction tag. */
  earned: Record<string, number>;
}

export interface StandingToday {
  since: string;
  exact: boolean;
  total: number;
  /** Faction tag -> standing earned today (every observed faction, 0 included). */
  factions: Record<string, number>;
}

/** Today's daily standing caps. The game counts each cap down as standing is
 *  earned (DailyAffiliation for the regular factions, DailyAffiliationOde for
 *  the Ode); a full cap is 16,000 + 500 x player level. */
export interface DailyCaps {
  cap: number;
  remaining: number;
  odeCap: number;
  odeRemaining: number;
  /** Standing earned today: the larger of what the caps' countdown implies
   *  and what we tracked (the countdown is exact for the whole day). */
  earned: number;
  /** True when `earned` covers the whole day (game countdown or tracking from reset). */
  exact: boolean;
}

const ODE_TAG = "OdeSyndicate";

/** Combine the game's remaining-cap counters with our tracked earnings.
 *  `reported` are the game's remaining values (lowest of the fresh sources).
 *  If a counter hasn't moved from full, it's either untouched today or the
 *  game didn't count it down yet, so our tracked earnings are subtracted. */
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
    const counted = rem != null && rem < cap; // the game is counting this cap down
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

const BASE = process.env.SFHELPER_HOME ?? join(homedir(), ".config", "sfhelper");
const STATE_PATH = join(BASE, "standing.json");

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const resetOf = (ms: number): number => Date.parse(`${dayKey(ms)}T00:00:00Z`);

async function load(): Promise<State | null> {
  try {
    const s = JSON.parse(await readFile(STATE_PATH, "utf8")) as State;
    return s && typeof s.day === "string" && s.last && s.earned ? s : null;
  } catch {
    return null;
  }
}

async function save(s: State): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(s));
}

/** Record the current per-faction Standing; returns today's tally. */
export async function recordStanding(current: Record<string, number>, now = Date.now()): Promise<StandingToday> {
  const prev = await load();
  const day = dayKey(now);
  const reset = resetOf(now);
  let s: State;

  if (!prev || prev.day !== day) {
    // New day (or first run). The previous observation is a usable baseline
    // only if it was taken just before this reset.
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
      // A faction seen for the first time starts its own baseline.
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
