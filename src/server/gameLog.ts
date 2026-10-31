import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ICON_AFTER_OWNER_S = 4;
const SKEW_MS = 60_000;
const MAX_SYNC_LAG_MS = 6 * 3600_000;

const LOG_TAIL = join("pfx", "drive_c", "users", "steamuser", "AppData", "Local", "Soulframe", "EE.log");

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
    }
  }
  return [...libs];
}

async function findLog(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Soulframe", "EE.log"));
  for (const lib of await steamLibraries()) {
    const compat = join(lib, "steamapps", "compatdata");
    try {
      for (const id of await readdir(compat)) candidates.push(join(compat, id, LOG_TAIL));
    } catch {
    }
  }
  let best: { path: string; mtime: number } | null = null;
  for (const path of candidates) {
    try {
      const s = await stat(path);
      if (!best || s.mtimeMs > best.mtime) best = { path, mtime: s.mtimeMs };
    } catch {
    }
  }
  return best?.path ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseUtc(s: string): number | null {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]!);
  if (mon < 0) return null;
  return Date.UTC(Number(m[6]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

interface LogEvents {
  start: number;
  acquired: Map<string, number[]>;
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
          lastOwner = null;
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

export interface LoggedTrade {
  at: number;
  partner: string | null;
  offered: string[];
  received: string[];
}

const CONFIRM_RE = /You are offering:\n([\s\S]*?)\n*and will receive from (.+?) the following:\n?([\s\S]*?), leftItem=/;
const INVITE_RE = /description=(.+?) wants to trade with you/;
const TIME_RE = /^(\d+\.\d+) /;
const itemLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const playerName = (s: string) => s.replace(/[\uE000-\uF8FF]/g, "").trim();

export interface GameRefusals {
  count: number;
  first: number;
  last: number;
}

const STILL_REFUSED_MS = 5 * 60_000;
const REFUSED_RE = /^(\d+\.\d+) .*HTTP\/1\.[01] (?:403|429)\b/;
const HTTP_DATE_RE = /Date: (\w{3}, \d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT)/;

let refusalCache: { key: string; value: GameRefusals | null } | null = null;

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

export async function gameBeingRefused(now = Date.now(), path?: string): Promise<GameRefusals | null> {
  const r = await gameRefusals(path);
  return r && now - r.last < STILL_REFUSED_MS ? r : null;
}

export function gameRefusedMessage(r: GameRefusals): string {
  const since = new Date(r.first).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `Soulframe's servers are refusing your game's requests (since ${since}), so SFHelper is waiting.`;
}

const AGARI_SPAWN_RE = /SubBossEncounter\.lua: \[[^\]-]*-([^\]]+)\] Spawning sub-boss/;
const AGENT_RE = /OnAgentCreated \/Npc\/(\w+?Agent)\d*\s/;
const AGENT_WITHIN = 5;

let agariCache: { key: string; value: Record<string, string> } | null = null;

export async function loggedAgari(path?: string): Promise<Record<string, string>> {
  const log = path ?? (await findLog());
  if (!log) return {};
  let key: string;
  try {
    const s = await stat(log);
    key = `${log}:${s.size}:${s.mtimeMs}`;
  } catch {
    return {};
  }
  if (agariCache?.key === key) return agariCache.value;

  const spawned: Record<string, string> = {};
  let spot: string | null = null;
  let since = 0;
  const lines = createInterface({ input: createReadStream(log, { encoding: "utf8", flags: "r" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (spot !== null) {
        const a = line.includes("OnAgentCreated") ? AGENT_RE.exec(line) : null;
        if (a) {
          spawned[spot] = a[1]!;
          spot = null;
          continue;
        }
        if (++since > AGENT_WITHIN) spot = null;
      }
      if (!line.includes("Spawning sub-boss")) continue;
      const m = AGARI_SPAWN_RE.exec(line);
      if (m) {
        spot = m[1]!;
        since = 0;
      }
    }
  } catch {
    return {};
  } finally {
    lines.close();
  }
  agariCache = { key, value: spawned };
  return spawned;
}

export interface LoggedMastery {
  other: number;
  items: number | null;
}

const OTHER_XP_RE = /Total calculated MissionProgressXP is (\d+)/;
const ITEM_XP_RE = /Player has (\d+) \(item based\) XP/;

let masteryCache: { key: string; value: LoggedMastery | null } | null = null;

export async function loggedMastery(path?: string): Promise<LoggedMastery | null> {
  const log = path ?? (await findLog());
  if (!log) return null;
  let key: string;
  try {
    const s = await stat(log);
    key = `${log}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
  if (masteryCache?.key === key) return masteryCache.value;

  let other: number | null = null;
  let items: number | null = null;
  const lines = createInterface({ input: createReadStream(log, { encoding: "utf8", flags: "r" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes("XP")) continue;
      const o = OTHER_XP_RE.exec(line);
      if (o) {
        other = Number(o[1]);
        continue;
      }
      const it = ITEM_XP_RE.exec(line);
      if (it && Number(it[1]) > 0) items = Number(it[1]);
    }
  } catch {
    return null;
  } finally {
    lines.close();
  }
  const value = other === null ? null : { other, items };
  masteryCache = { key, value };
  return value;
}

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

export function objectIdTime(id: string | null | undefined): number | null {
  if (!id || !/^[0-9a-f]{24}$/i.test(id)) return null;
  const secs = parseInt(id.slice(0, 8), 16);
  return secs > 0 ? secs * 1000 : null;
}

export interface TimedWeapon {
  id: string;
  key: string;
}

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
  const pick = (times: number[] | undefined, leaf: string, synced: number): number | null => {
    if (!times) return null;
    const u = used(leaf);
    for (let i = times.length - 1; i >= 0; i--) {
      const t = times[i]!;
      if (t > synced + SKEW_MS) continue;
      if (t < synced - MAX_SYNC_LAG_MS) break;
      if (!u.has(t) && ![...u].some((x) => x >= t && x - t <= ICON_AFTER_OWNER_S * 1000)) return t;
    }
    return null;
  };

  for (const w of wanted) {
    if (w.synced + SKEW_MS < ev.start) continue;
    const t = pick(ev.acquired.get(w.leaf), w.leaf, w.synced) ?? pick(ev.owner.get(w.leaf), w.leaf, w.synced);
    if (t === null) continue;
    used(w.leaf).add(t);
    out.set(w.id, t);
  }
  return out;
}
