/** Exact weapon pickup times from the game's own log (EE.log). Read-only.
 *
 *  A new weapon only reaches the server inventory when the game next syncs, so
 *  the inventory diff can be minutes late. The game logs the moment itself:
 *  picking a weapon up logs
 *      "Set owner called multiple times on item <WeaponLeaf>"
 *  and, about a second later, loads that weapon's acquired-toast icon
 *      "ResourceLoader ... (/SF/Interface/Graphics/StoreItems/Weapons/<Icon>.png)".
 *  The owner line also appears when a weapon on the ground is hovered or one is
 *  equipped, so only an owner line followed shortly by an icon load counts as
 *  an acquisition; a bare owner line is a weaker fallback.
 *
 *  Log times are seconds since launch; the header's "Current time ... [UTC: ...]"
 *  line anchors them. EE.log is rewritten every launch, so only the current
 *  session's pickups can be timed this way. Older ones fall back to the time
 *  embedded in the weapon's ItemId (a MongoDB ObjectId stamped when the server
 *  created the item, i.e. the sync time).
 */

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** An icon load counts as an acquisition if an owner line preceded it this closely. */
const ICON_AFTER_OWNER_S = 4;
/** Allowed clock skew between this machine (log) and the server (ItemId time). */
const SKEW_MS = 60_000;
/** How far before the sync a pickup can plausibly have happened. */
const MAX_SYNC_LAG_MS = 6 * 3600_000;

const LOG_TAIL = join("pfx", "drive_c", "users", "steamuser", "AppData", "Local", "Soulframe", "EE.log");

/** Steam library roots (native and Flatpak installs, plus extra library folders). */
async function steamLibraries(): Promise<string[]> {
  const home = homedir();
  const roots = [
    join(home, ".local", "share", "Steam"),
    join(home, ".steam", "steam"),
    join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
  ];
  const libs = new Set<string>(roots);
  for (const root of roots) {
    try {
      const vdf = await readFile(join(root, "steamapps", "libraryfolders.vdf"), "utf8");
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1]!.replace(/\\\\/g, "\\"));
    } catch {
      // No Steam here.
    }
  }
  return [...libs];
}

/** Candidate EE.log locations; the most recently written one wins. */
async function findLog(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Soulframe", "EE.log"));
  for (const lib of await steamLibraries()) {
    const compat = join(lib, "steamapps", "compatdata");
    try {
      for (const id of await readdir(compat)) candidates.push(join(compat, id, LOG_TAIL));
    } catch {
      // No Proton prefixes in this library.
    }
  }
  let best: { path: string; mtime: number } | null = null;
  for (const path of candidates) {
    try {
      const s = await stat(path);
      if (!best || s.mtimeMs > best.mtime) best = { path, mtime: s.mtimeMs };
    } catch {
      // Not here.
    }
  }
  return best?.path ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu Oct  1 17:19:03 2026" (UTC) -> epoch ms. */
function parseUtc(s: string): number | null {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]!);
  if (mon < 0) return null;
  return Date.UTC(Number(m[6]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

interface LogEvents {
  /** Epoch ms the log's clock starts at. */
  start: number;
  /** Owner line followed by an icon load: weapon leaf -> times (epoch ms, ascending). */
  acquired: Map<string, number[]>;
  /** Every owner line: weapon leaf -> times (epoch ms, ascending). */
  owner: Map<string, number[]>;
}

const OWNER_RE = /^(\d+\.\d+) .*Set owner called multiple times on item (\S+)/;
const ICON_RE = /^(\d+\.\d+) .*ResourceLoader \S+ \(\/SF\/Interface\/Graphics\/StoreItems\/Weapons\//;
const START_RE = /Current time: .*\[UTC: (.+)\]/;

async function readEvents(path: string): Promise<LogEvents | null> {
  let start: number | null = null;
  const acquired = new Map<string, number[]>();
  const owner = new Map<string, number[]>();
  let lastOwner: { t: number; leaf: string } | null = null;
  const push = (m: Map<string, number[]>, k: string, v: number) => {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
  };

  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8", flags: "r" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (start === null) {
        const h = START_RE.exec(line);
        if (h) start = parseUtc(h[1]!);
        continue;
      }
      // Cheap substring checks first: the log can be very large.
      if (line.includes("Set owner called")) {
        const m = OWNER_RE.exec(line);
        if (!m) continue;
        const t = start + Math.round(Number(m[1]) * 1000);
        lastOwner = { t, leaf: m[2]! };
        push(owner, m[2]!, t);
      } else if (line.includes("StoreItems/Weapons/") && line.includes("ResourceLoader")) {
        const m = ICON_RE.exec(line);
        if (!m || !lastOwner) continue;
        const t = start + Math.round(Number(m[1]) * 1000);
        if (t - lastOwner.t <= ICON_AFTER_OWNER_S * 1000) {
          push(acquired, lastOwner.leaf, t);
          lastOwner = null; // one icon per acquisition
        }
      }
    }
  } catch {
    return null;
  } finally {
    lines.close();
  }
  return start === null ? null : { start, acquired, owner };
}

/** A completed trade, as the current game log records it. Accepting a trade
 *  logs its confirmation dialog, which spans several lines:
 *      Dialog::CreateOkCancel(description=Are you sure you want to accept this trade? You are offering:
 *      Fire Fungus
 *
 *      and will receive from NordicGhost the following:
 *      Wreath, leftItem=...)
 *  and then "Dialog::CreateOk(description=The trade was successful!". Items are
 *  in-game names without counts. */
export interface LoggedTrade {
  /** Epoch ms the game reported the trade successful. */
  at: number;
  partner: string | null;
  offered: string[];
  received: string[];
}

const CONFIRM_RE = /You are offering:\n([\s\S]*?)\n*and will receive from (.+?) the following:\n?([\s\S]*?), leftItem=/;
const INVITE_RE = /description=(.+?) wants to trade with you/;
const TIME_RE = /^(\d+\.\d+) /;
const itemLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
/** Names carry a private-use glyph after them (the platform icon, U+E000). */
const playerName = (s: string) => s.replace(/[\uE000-\uF8FF]/g, "").trim();

/** DE's servers turning the game itself away. Each refused request logs
 *      HTTP/1.1 403 Forbidden
 *  followed by the response headers, among them the server's
 *      Date: Mon, 26 Oct 2026 21:06:09 GMT
 *  (when it happened on 2026-10-26, every request was refused by Akamai, DE's
 *  CDN, even the unauthenticated world state, and the game couldn't save
 *  progress). While the game is being refused, anything SFHelper sends from
 *  the same network would be refused too, and only prolong the block. */
export interface GameRefusals {
  count: number;
  /** First and latest refusal this game session (epoch ms). */
  first: number;
  last: number;
}

/** Refusals this recent mean the game is still being turned away (it retries
 *  failed saves every 10 seconds or so). */
const STILL_REFUSED_MS = 5 * 60_000;
const REFUSED_RE = /^(\d+\.\d+) .*HTTP\/1\.[01] (?:403|429)\b/;
const HTTP_DATE_RE = /Date: (\w{3}, \d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT)/;

let refusalCache: { key: string; value: GameRefusals | null } | null = null;

/** Every refusal in the current game log, or null if there are none. */
export async function gameRefusals(path?: string): Promise<GameRefusals | null> {
  const log = path ?? (await findLog());
  if (!log) return null;
  let key: string;
  try {
    const s = await stat(log);
    key = `${log}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
  if (refusalCache?.key === key) return refusalCache.value;

  let start: number | null = null;
  let count = 0;
  let first = 0;
  let last = 0;
  const note = (t: number) => {
    count += 1;
    if (!first) first = t;
    last = Math.max(last, t);
  };
  // A refusal waiting for its Date header (its log time, used if none follows).
  let pending: number | null = null;
  let headerLines = 0;
  const lines = createInterface({ input: createReadStream(log, { encoding: "utf8", flags: "r" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (start === null) {
        const h = START_RE.exec(line);
        if (h) start = parseUtc(h[1]!);
        continue;
      }
      if (pending !== null) {
        const d = line.includes("Date: ") ? HTTP_DATE_RE.exec(line) : null;
        if (d) {
          note(Date.parse(d[1]!));
          pending = null;
          continue;
        }
        if (++headerLines > 10) {
          note(pending);
          pending = null;
        }
      }
      if (!line.includes("HTTP/1.")) continue;
      const m = REFUSED_RE.exec(line);
      if (!m) continue;
      if (pending !== null) note(pending);
      pending = start + Math.round(Number(m[1]) * 1000);
      headerLines = 0;
    }
    if (pending !== null) note(pending);
  } catch {
    return null;
  } finally {
    lines.close();
  }
  const value = count ? { count, first, last } : null;
  refusalCache = { key, value };
  return value;
}

/** The game's refusals if it's still being refused right now, else null. */
export async function gameBeingRefused(now = Date.now(), path?: string): Promise<GameRefusals | null> {
  const r = await gameRefusals(path);
  return r && now - r.last < STILL_REFUSED_MS ? r : null;
}

export function gameRefusedMessage(r: GameRefusals): string {
  const since = new Date(r.first).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `Soulframe's servers are refusing your game's requests (since ${since}), so SFHelper is waiting.`;
}

/** Every trade completed in the current game session, oldest first. */
export async function logTrades(): Promise<LoggedTrade[]> {
  const path = await findLog();
  if (!path) return [];
  const out: LoggedTrade[] = [];
  let start: number | null = null;
  let collecting: string[] | null = null;
  let confirm: Omit<LoggedTrade, "at"> | null = null;
  let invitedBy: string | null = null;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8", flags: "r" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (start === null) {
        const h = START_RE.exec(line);
        if (h) start = parseUtc(h[1]!);
        continue;
      }
      if (collecting) {
        collecting.push(line);
        if (!line.includes(", leftItem=") && collecting.length < 200) continue;
        const m = CONFIRM_RE.exec(collecting.join("\n"));
        collecting = null;
        if (m) confirm = { partner: playerName(m[2]!), offered: itemLines(m[1]!), received: itemLines(m[3]!) };
        continue;
      }
      if (!line.includes("Dialog::Create")) continue;
      if (line.includes("You are offering:")) {
        collecting = [line.slice(line.indexOf("You are offering:"))];
      } else if (line.includes("description=The trade was successful!")) {
        const t = TIME_RE.exec(line);
        if (t) out.push({ at: start + Math.round(Number(t[1]) * 1000), ...(confirm ?? { partner: invitedBy, offered: [], received: [] }) });
        confirm = null;
        invitedBy = null;
      } else {
        const inv = INVITE_RE.exec(line);
        if (inv) invitedBy = playerName(inv[1]!);
      }
    }
  } catch {
    return out;
  } finally {
    lines.close();
  }
  return out;
}

/** Server creation time embedded in a 24-hex ObjectId, or null. */
export function objectIdTime(id: string | null | undefined): number | null {
  if (!id || !/^[0-9a-f]{24}$/i.test(id)) return null;
  const secs = parseInt(id.slice(0, 8), 16);
  return secs > 0 ? secs * 1000 : null;
}

export interface TimedWeapon {
  id: string;
  key: string;
}

/** Pickup times from the current game log for the given weapons (id -> epoch
 *  ms). Weapons with no matching log event are left out. `taken` holds times
 *  already assigned to other weapons, per leaf, so one event is never reused. */
export async function logPickupTimes(
  weapons: TimedWeapon[],
  taken: Map<string, Set<number>> = new Map(),
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = weapons
    .map((w) => ({ ...w, leaf: w.key.split("/").pop()!, synced: objectIdTime(w.id) }))
    .filter((w): w is typeof w & { synced: number } => w.synced !== null)
    .sort((a, b) => a.synced - b.synced);
  if (!wanted.length) return out;

  const path = await findLog();
  if (!path) return out;
  const ev = await readEvents(path);
  if (!ev) return out;

  const used = (leaf: string) => {
    let s = taken.get(leaf);
    if (!s) taken.set(leaf, (s = new Set()));
    return s;
  };
  // Latest unused event for this leaf that precedes the sync.
  const pick = (times: number[] | undefined, leaf: string, synced: number): number | null => {
    if (!times) return null;
    const u = used(leaf);
    for (let i = times.length - 1; i >= 0; i--) {
      const t = times[i]!;
      if (t > synced + SKEW_MS) continue;
      if (t < synced - MAX_SYNC_LAG_MS) break;
      // Skip a used time, and an owner line belonging to an already-used pickup.
      if (!u.has(t) && ![...u].some((x) => x >= t && x - t <= ICON_AFTER_OWNER_S * 1000)) return t;
    }
    return null;
  };

  for (const w of wanted) {
    if (w.synced + SKEW_MS < ev.start) continue; // synced before this log began
    const t = pick(ev.acquired.get(w.leaf), w.leaf, w.synced) ?? pick(ev.owner.get(w.leaf), w.leaf, w.synced);
    if (t === null) continue;
    used(w.leaf).add(t);
    out.set(w.id, t);
  }
  return out;
}
