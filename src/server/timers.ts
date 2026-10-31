/** The game's own timers, from the inventory's ExpiryTimeTrackers, each a tag
 *  and the time it ends (Unix seconds). Only the ones the game expires on its
 *  own (AutoExpire) are timers; the others are long-past quest flags. Known
 *  ones, from the game's scripts:
 *   - "<spot>-SubBoss": an Agari (the game's sub-bosses) slain at that spawn
 *     spot, e.g. "StoneHengeA-SubBoss"; it can't return there until the timer
 *     ends, 30 minutes after the kill (SubBossEncounter.lua).
 *   - "UPGRADEGIVEN_GODANDGHOST": a Blessed Meeting's boon was taken; no other
 *     Ancestor or Omen Beast offers one for 24 hours (BoonGiver.lua).
 *  The game has no display names for the tags, so names come from them, and
 *  an Agari timer takes the name of the Agari that spawned at its spot when the
 *  game log has it ("Knell Knight").
 */

import { loggedAgari } from "./gameLog";
import { getAgentNamer } from "./enemies";

export interface GameTimer {
  tag: string;
  /** What kind of timer it is, if known ("Agari respawn"). */
  kind: string | null;
  /** Where or what ("Stone Henge A", "Blessed Meeting"). */
  name: string;
  /** What's back when it ends, for the notification. */
  ready: string;
  /** An Agari timer's spawn spot, as the game names it ("StoneHengeA"). */
  spot?: string;
  /** When it ends (ms epoch). */
  expiry: number;
}

/** "StoneHengeA" -> "Stone Henge A"; "GODANDGHOST" -> "Godandghost". */
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

const KNOWN: [RegExp, (m: RegExpExecArray) => Label][] = [
  [/^UPGRADEGIVEN_GODANDGHOST$/, () => ({ kind: "Once a day, after a boon", name: "Blessed Meeting", ready: "Blessed Meetings can happen again" })],
  [/^(.+)-SubBoss$/i, (m) => {
    const place = words(m[1]!);
    return { kind: "Agari respawn", name: place, ready: `The Agari at ${place} can return`, spot: m[1]! };
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

/** Agari timers named after the Agari last spawned at their spot (spot ->
 *  agent type, from the game log), where its name is known; the rest as they
 *  are. Only sub-boss agent types count: some spots (a siege's officers) spawn
 *  an ordinary enemy type whose in-game name as an Agari isn't in the data. */
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

/** nameAgari with the current game log and the bundled enemy names. */
export async function withAgariNames(timers: GameTimer[]): Promise<GameTimer[]> {
  if (!timers.some((t) => t.spot)) return timers;
  const [spawned, agentName] = await Promise.all([loggedAgari(), getAgentNamer()]);
  return nameAgari(timers, spawned, agentName);
}

/** Every self-expiring timer in the inventory, soonest first. */
export function parseTimers(raw: Record<string, unknown>): GameTimer[] {
  const out: GameTimer[] = [];
  for (const e of Array.isArray(raw.ExpiryTimeTrackers) ? raw.ExpiryTimeTrackers : []) {
    const t = e as { Tag?: unknown; ExpiryTime?: unknown; AutoExpire?: unknown };
    if (typeof t.Tag !== "string" || typeof t.ExpiryTime !== "number" || t.AutoExpire !== true) continue;
    out.push({ tag: t.Tag, ...timerLabel(t.Tag), expiry: t.ExpiryTime * 1000 });
  }
  return out.sort((a, b) => a.expiry - b.expiry);
}
