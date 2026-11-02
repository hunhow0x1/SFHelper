import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

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

const FIND_TTL_MS = 30_000;
let found: { at: number; path: string | null } | null = null;

async function findLog(): Promise<string | null> {
  if (found && Date.now() - found.at < FIND_TTL_MS) return found.path;
  found = { at: Date.now(), path: await locateLog() };
  return found.path;
}

async function locateLog(): Promise<string | null> {
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

export interface LoggedTrade {
  at: number;
  partner: string | null;
  offered: string[];
  received: string[];
}

export interface GameRefusals {
  count: number;
  first: number;
  last: number;
}

export interface LoggedMastery {
  other: number;
  items: number | null;
}

const OWNER_RE = /^(\d+\.\d+) .*Set owner called multiple times on item (\S+)/;
const ICON_RE = /^(\d+\.\d+) .*ResourceLoader \S+ \(\/SF\/Interface\/Graphics\/StoreItems\/Weapons\//;
const START_RE = /Current time: .*\[UTC: (.+)\]/;
const CONFIRM_RE = /You are offering:\n([\s\S]*?)\n*and will receive from (.+?) the following:\n?([\s\S]*?), leftItem=/;
const INVITE_RE = /description=(.+?) wants to trade with you/;
const TIME_RE = /^(\d+\.\d+) /;
const STILL_REFUSED_MS = 5 * 60_000;
const REFUSED_RE = /^(\d+\.\d+) .*HTTP\/1\.[01] (?:403|429)\b/;
const HTTP_DATE_RE = /Date: (\w{3}, \d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT)/;
const AGARI_SPAWN_RE = /SubBossEncounter\.lua: \[[^\]-]*-([^\]]+)\] Spawning sub-boss/;
const AGENT_RE = /OnAgentCreated \/Npc\/(\w+?Agent)\d*\s/;
const AGENT_WITHIN = 5;
const OTHER_XP_RE = /Total calculated MissionProgressXP is (\d+)/;
const ITEM_XP_RE = /Player has (\d+) \(item based\) XP/;
const HEAD_BYTES = 256;
const CHUNK_BYTES = 1 << 20;

const itemLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const playerName = (s: string) => s.replace(/[\uE000-\uF8FF]/g, "").trim();

interface Scan {
  path: string;
  head: string;
  offset: number;
  rest: string;
  decoder: StringDecoder;
  start: number | null;
  refusals: { count: number; first: number; last: number; pending: number | null; headerLines: number };
  agari: { spawned: Record<string, string>; spot: string | null; since: number };
  mastery: { other: number | null; items: number | null };
  trades: { out: LoggedTrade[]; collecting: string[] | null; confirm: Omit<LoggedTrade, "at"> | null; invitedBy: string | null };
  events: { acquired: Map<string, number[]>; owner: Map<string, number[]>; lastOwner: { t: number; leaf: string } | null };
}

function newScan(path: string, head: string): Scan {
  return {
    path,
    head,
    offset: 0,
    rest: "",
    decoder: new StringDecoder("utf8"),
    start: null,
    refusals: { count: 0, first: 0, last: 0, pending: null, headerLines: 0 },
    agari: { spawned: {}, spot: null, since: 0 },
    mastery: { other: null, items: null },
    trades: { out: [], collecting: null, confirm: null, invitedBy: null },
    events: { acquired: new Map(), owner: new Map(), lastOwner: null },
  };
}

function feedAgari(a: Scan["agari"], line: string): void {
  if (a.spot !== null) {
    const m = line.includes("OnAgentCreated") ? AGENT_RE.exec(line) : null;
    if (m) {
      a.spawned[a.spot] = m[1]!;
      a.spot = null;
      return;
    }
    if (++a.since > AGENT_WITHIN) a.spot = null;
  }
  if (!line.includes("Spawning sub-boss")) return;
  const m = AGARI_SPAWN_RE.exec(line);
  if (m) {
    a.spot = m[1]!;
    a.since = 0;
  }
}

function feedMastery(x: Scan["mastery"], line: string): void {
  if (!line.includes("XP")) return;
  const o = OTHER_XP_RE.exec(line);
  if (o) {
    x.other = Number(o[1]);
    return;
  }
  const it = ITEM_XP_RE.exec(line);
  if (it && Number(it[1]) > 0) x.items = Number(it[1]);
}

function noteRefusal(r: Scan["refusals"], t: number): void {
  r.count += 1;
  if (!r.first) r.first = t;
  r.last = Math.max(r.last, t);
}

function feedRefusals(r: Scan["refusals"], line: string, start: number): void {
  if (r.pending !== null) {
    const d = line.includes("Date: ") ? HTTP_DATE_RE.exec(line) : null;
    if (d) {
      noteRefusal(r, Date.parse(d[1]!));
      r.pending = null;
      return;
    }
    if (++r.headerLines > 10) {
      noteRefusal(r, r.pending);
      r.pending = null;
    }
  }
  if (!line.includes("HTTP/1.")) return;
  const m = REFUSED_RE.exec(line);
  if (!m) return;
  if (r.pending !== null) noteRefusal(r, r.pending);
  r.pending = start + Math.round(Number(m[1]) * 1000);
  r.headerLines = 0;
}

function feedTrades(x: Scan["trades"], line: string, start: number): void {
  if (x.collecting) {
    x.collecting.push(line);
    if (!line.includes(", leftItem=") && x.collecting.length < 200) return;
    const m = CONFIRM_RE.exec(x.collecting.join("\n"));
    x.collecting = null;
    if (m) x.confirm = { partner: playerName(m[2]!), offered: itemLines(m[1]!), received: itemLines(m[3]!) };
    return;
  }
  if (!line.includes("Dialog::Create")) return;
  if (line.includes("You are offering:")) {
    x.collecting = [line.slice(line.indexOf("You are offering:"))];
  } else if (line.includes("description=The trade was successful!")) {
    const t = TIME_RE.exec(line);
    if (t) x.out.push({ at: start + Math.round(Number(t[1]) * 1000), ...(x.confirm ?? { partner: x.invitedBy, offered: [], received: [] }) });
    x.confirm = null;
    x.invitedBy = null;
  } else {
    const inv = INVITE_RE.exec(line);
    if (inv) x.invitedBy = playerName(inv[1]!);
  }
}

function pushTime(m: Map<string, number[]>, k: string, v: number): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function feedEvents(e: Scan["events"], line: string, start: number): void {
  if (line.includes("Set owner called")) {
    const m = OWNER_RE.exec(line);
    if (!m) return;
    const t = start + Math.round(Number(m[1]) * 1000);
    e.lastOwner = { t, leaf: m[2]! };
    pushTime(e.owner, m[2]!, t);
  } else if (line.includes("StoreItems/Weapons/") && line.includes("ResourceLoader")) {
    const m = ICON_RE.exec(line);
    if (!m || !e.lastOwner) return;
    const t = start + Math.round(Number(m[1]) * 1000);
    if (t - e.lastOwner.t <= ICON_AFTER_OWNER_S * 1000) {
      pushTime(e.acquired, e.lastOwner.leaf, t);
      e.lastOwner = null;
    }
  }
}

function feed(s: Scan, line: string): void {
  feedAgari(s.agari, line);
  feedMastery(s.mastery, line);
  if (s.start === null) {
    const h = START_RE.exec(line);
    if (h) s.start = parseUtc(h[1]!);
    return;
  }
  feedRefusals(s.refusals, line, s.start);
  feedTrades(s.trades, line, s.start);
  feedEvents(s.events, line, s.start);
}

let scan: Scan | null = null;
let scanning: Promise<unknown> = Promise.resolve();

async function readNew(path: string): Promise<Scan | null> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await fh.stat();
    const headBuf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    if (headBuf.length) await fh.read(headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString("latin1");
    if (!scan || scan.path !== path || size < scan.offset || !head.startsWith(scan.head)) scan = newScan(path, head);
    const s = scan;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, size - s.offset)));
    while (s.offset < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - s.offset), s.offset);
      if (!bytesRead) break;
      s.offset += bytesRead;
      const lines = (s.rest + s.decoder.write(buf.subarray(0, bytesRead))).split("\n");
      s.rest = lines.pop()!;
      for (const line of lines) feed(s, line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    return s;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

function scanLog(path: string): Promise<Scan | null> {
  const run = scanning.then(() => readNew(path));
  scanning = run.catch(() => undefined);
  return run;
}

async function currentScan(path?: string): Promise<Scan | null> {
  const log = path ?? (await findLog());
  return log ? scanLog(log) : null;
}

export async function gameRefusals(path?: string): Promise<GameRefusals | null> {
  const s = await currentScan(path);
  if (!s) return null;
  const r = s.refusals;
  let { count, first, last } = r;
  if (r.pending !== null) {
    count += 1;
    if (!first) first = r.pending;
    last = Math.max(last, r.pending);
  }
  return count ? { count, first, last } : null;
}

export async function gameBeingRefused(now = Date.now(), path?: string): Promise<GameRefusals | null> {
  const r = await gameRefusals(path);
  return r && now - r.last < STILL_REFUSED_MS ? r : null;
}

export function gameRefusedMessage(r: GameRefusals): string {
  const since = new Date(r.first).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `Soulframe's servers are refusing your game's requests (since ${since}), so SFHelper is waiting.`;
}

export async function loggedAgari(path?: string): Promise<Record<string, string>> {
  const s = await currentScan(path);
  return s ? { ...s.agari.spawned } : {};
}

export async function loggedMastery(path?: string): Promise<LoggedMastery | null> {
  const s = await currentScan(path);
  return s && s.mastery.other !== null ? { other: s.mastery.other, items: s.mastery.items } : null;
}

export async function logTrades(path?: string): Promise<LoggedTrade[]> {
  const s = await currentScan(path);
  return s ? [...s.trades.out] : [];
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

  const s = await currentScan();
  if (!s || s.start === null) return out;
  const ev = { start: s.start, acquired: s.events.acquired, owner: s.events.owner };

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
