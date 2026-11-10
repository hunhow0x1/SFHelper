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

export interface RefusalDetail {
  at: number;
  status: string;
  server: string | null;
  before: string;
  after: string | null;
}

interface OpenRefusal {
  logAt: number;
  at: number | null;
  status: string;
  server: string | null;
  before: string;
  lines: number;
}

export interface LoggedCollector {
  at: number;
  x: number | null;
  z: number | null;
  started: number | null;
  ended: number | null;
  logAt: number;
}

export interface LoggedBlessed {
  at: number;
  ended: number | null;
  logAt: number;
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
const HTTP_STATUS_RE = /HTTP\/1\.[01] (\d{3}[^\r\n]*)/;
const HTTP_HEADER_RE = /^\d+\.\d+ \w+ \[\w+\]: [A-Za-z][\w-]*: /;
const HTTP_SERVER_RE = /: Server: (.+)$/;
const LOG_MESSAGE_RE = /^\d+\.\d+ \w+ \[\w+\]: (.*)$/;
const MAX_HEADER_LINES = 12;
const MAX_REFUSAL_DETAILS = 50;
const MAX_CONTEXT_CHARS = 160;
const AGARI_SPAWN_RE = /SubBossEncounter\.lua: \[[^\]-]*-([^\]]+)\] Spawning sub-boss/;
const AGARI_CREATED_RE = /SubBossEncounter\.lua: \[[^\]-]*-([^\]]+)\] Created agent at/;
const AGENT_RE = /OnAgentCreated \/Npc\/(\w+?Agent)\d*\s/;
const AGENT_WITHIN = 5;
const CREATED_WITHIN = 1;
const LOCATION_RE = /SetCurrentLocation: ([\w-]+)/;
const ENTER_LEVEL_RE = /STATS ENTER_LEVEL \/SF\/Levels\/Procs\/(\w+)(\/)?/;
const OTHER_XP_RE = /Total calculated MissionProgressXP is (\d+)/;
const ITEM_XP_RE = /Player has (\d+) \(item based\) XP/;
const COLLECTOR_GONE = [
  "OnPrimed: hint was unprimed and never activated",
  "OnPrimed: Players left the area",
  "Collector encounter ending",
  "playing collectorCinLeaving",
  "Shutdown due to streaming",
  "Shutdown collector",
  "Collector encounter ended",
  "Collector shutdown complete",
];
const COLLECTOR_RE = /^(\d+\.\d+) .*PrimeMissionOnHint\b[^[]*\[[^\]]*\] at pos \[\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+).*missionTag MT_COLLECTOR/;
const COLLECTOR_SAME_ARRIVAL_MS = 5_000;
const BLESSED_START_RE = /ENCMGR: Encounter \S*GodsAndGhosts?Encounter started at /;
const BLESSED_END_RE = /ENCMGR: Encounter \[\S*GodsAndGhosts?Encounter\] (?:has completed|was abandoned)/;
const BLESSED_FAILED_WITHIN_MS = 1_000;
const BUILD_RE = /Build Label: (\S+)/;
const CACHE_DIR_RE = /Scanning (.+?) for cache blocks/;
const PUBLIC_ADDRESS_RE = /public address \[?([0-9A-Fa-f:.]+?)\]?:\d+/;
const HEAD_BYTES = 256;
const CHUNK_BYTES = 1 << 20;

const itemLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const playerName = (s: string) => s.replace(/[\uE000-\uF8FF]/g, "").trim();

interface Scan {
  path: string;
  head: string;
  offset: number;
  mtime: number;
  rest: string;
  decoder: StringDecoder;
  start: number | null;
  game: { build: string | null; cacheDir: string | null; publicAddress: string | null };
  collector: Omit<LoggedCollector, "logAt"> | null;
  blessed: { last: Omit<LoggedBlessed, "logAt"> | null; failedAt: number | null };
  refusals: { count: number; first: number; last: number; open: OpenRefusal | null; before: string; details: RefusalDetail[] };
  agari: {
    spawned: Record<string, string>;
    spot: string | null;
    since: number;
    agent: string | null;
    agentAt: string | null;
    agentSince: number;
    location: string | null;
    dungeon: string | null;
  };
  mastery: { other: number | null; items: number | null };
  trades: { out: LoggedTrade[]; collecting: string[] | null; confirm: Omit<LoggedTrade, "at"> | null; invitedBy: string | null };
  events: { acquired: Map<string, number[]>; owner: Map<string, number[]>; lastOwner: { t: number; leaf: string } | null };
}

function newScan(path: string, head: string): Scan {
  return {
    path,
    head,
    offset: 0,
    mtime: 0,
    rest: "",
    decoder: new StringDecoder("utf8"),
    start: null,
    game: { build: null, cacheDir: null, publicAddress: null },
    collector: null,
    blessed: { last: null, failedAt: null },
    refusals: { count: 0, first: 0, last: 0, open: null, before: "", details: [] },
    agari: { spawned: {}, spot: null, since: 0, agent: null, agentAt: null, agentSince: 0, location: null, dungeon: null },
    mastery: { other: null, items: null },
    trades: { out: [], collecting: null, confirm: null, invitedBy: null },
    events: { acquired: new Map(), owner: new Map(), lastOwner: null },
  };
}

function learnAgari(a: Scan["agari"], spot: string, agent: string): void {
  if (a.dungeon && a.location) a.spawned[`Dungeon-${a.location}`] = `${a.dungeon}/${agent}`;
  else a.spawned[spot] = agent;
}

function feedAgari(a: Scan["agari"], line: string): void {
  const created = line.includes("OnAgentCreated") ? AGENT_RE.exec(line) : null;
  if (created) {
    a.agent = created[1]!;
    a.agentAt = TIME_RE.exec(line)?.[1] ?? null;
    a.agentSince = 0;
  } else if (a.agent !== null && ++a.agentSince > CREATED_WITHIN) {
    a.agent = null;
  }
  if (a.spot !== null) {
    if (created) {
      learnAgari(a, a.spot, created[1]!);
      a.spot = null;
      return;
    }
    if (++a.since > AGENT_WITHIN) a.spot = null;
  }
  if (line.includes("SetCurrentLocation: ")) {
    a.location = LOCATION_RE.exec(line)?.[1] ?? a.location;
  } else if (line.includes("STATS ENTER_LEVEL ")) {
    const m = ENTER_LEVEL_RE.exec(line);
    a.dungeon = m?.[2] ? m[1]! : null;
  } else if (line.includes("Created agent at")) {
    const m = a.agent && a.agentAt === TIME_RE.exec(line)?.[1] ? AGARI_CREATED_RE.exec(line) : null;
    if (m) learnAgari(a, m[1]!, a.agent!);
  } else if (line.includes("Spawning sub-boss")) {
    const m = AGARI_SPAWN_RE.exec(line);
    if (m) {
      a.spot = m[1]!;
      a.since = 0;
    }
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

const EMAIL_RE = /[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g;
const logMessage = (line: string): string => (LOG_MESSAGE_RE.exec(line)?.[1] ?? line).replace(EMAIL_RE, "[email]").trim().slice(0, MAX_CONTEXT_CHARS);

function closeRefusal(r: Scan["refusals"], after: string | null): void {
  const o = r.open!;
  r.open = null;
  const at = o.at ?? o.logAt;
  noteRefusal(r, at);
  if (r.details.length < MAX_REFUSAL_DETAILS) r.details.push({ at, status: o.status, server: o.server, before: o.before, after });
}

function feedRefusals(r: Scan["refusals"], line: string, start: number): void {
  const http = line.includes("HTTP/1.");
  if (r.open) {
    if (!http && HTTP_HEADER_RE.test(line) && ++r.open.lines <= MAX_HEADER_LINES) {
      const d = line.includes("Date: ") ? HTTP_DATE_RE.exec(line) : null;
      if (d) r.open.at = Date.parse(d[1]!);
      const server = line.includes("Server: ") ? HTTP_SERVER_RE.exec(line) : null;
      if (server) r.open.server = server[1]!.trim().slice(0, MAX_CONTEXT_CHARS);
      return;
    }
    closeRefusal(r, http || !line.trim() ? null : logMessage(line));
  }
  const m = http ? REFUSED_RE.exec(line) : null;
  if (m) {
    const status = HTTP_STATUS_RE.exec(line)?.[1]?.trim() ?? "";
    r.open = { logAt: start + Math.round(Number(m[1]) * 1000), at: null, status, server: null, before: r.before, lines: 0 };
    r.before = logMessage(line);
    return;
  }
  if (line.trim() && !HTTP_HEADER_RE.test(line)) r.before = logMessage(line);
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

function feedGame(g: Scan["game"], line: string): void {
  if (g.build === null && line.includes("Build Label: ")) g.build = BUILD_RE.exec(line)?.[1] ?? null;
  else if (g.cacheDir === null && line.includes(" for cache blocks")) g.cacheDir = CACHE_DIR_RE.exec(line)?.[1] ?? null;
}

function feedCollector(s: Scan, line: string, start: number): void {
  const objective = line.includes("CollectorShipObjective.lua: ");
  if (!objective && !line.includes("MT_COLLECTOR")) return;
  const t = TIME_RE.exec(line);
  if (!t) return;
  const at = start + Math.round(Number(t[1]) * 1000);
  const c = s.collector;
  const sameArrival = !!c && c.ended === null && c.started === null && Math.abs(at - c.at) <= COLLECTOR_SAME_ARRIVAL_MS;
  if (!objective) {
    const m = COLLECTOR_RE.exec(line);
    if (!m) return;
    if (sameArrival && c!.x === null) {
      c!.x = Number(m[2]);
      c!.z = Number(m[4]);
    } else {
      s.collector = { at, x: Number(m[2]), z: Number(m[4]), started: null, ended: null };
    }
    return;
  }
  if (line.includes("OnPrimed: Collector primed")) {
    if (!sameArrival) s.collector = { at, x: null, z: null, started: null, ended: null };
    return;
  }
  if (!c) return;
  if (line.includes("Collector encounter started")) c.started ??= at;
  else if (COLLECTOR_GONE.some((text) => line.includes(text))) c.ended ??= at;
}

function feedBlessed(b: Scan["blessed"], line: string, start: number): void {
  if (!line.includes("GodsAndGhost")) return;
  const t = TIME_RE.exec(line);
  const at = t ? start + Math.round(Number(t[1]) * 1000) : null;
  if (at === null) return;
  if (line.includes("GodsAndGhostENC: ")) {
    b.failedAt = at;
    if (b.last && b.last.ended === null) b.last.ended = at;
    return;
  }
  if (BLESSED_START_RE.test(line)) {
    const failed = b.failedAt !== null && at - b.failedAt <= BLESSED_FAILED_WITHIN_MS;
    b.last = { at, ended: failed ? at : null };
    return;
  }
  if (b.last && b.last.ended === null && BLESSED_END_RE.test(line)) b.last.ended = at;
}

function feed(s: Scan, line: string): void {
  if (s.game.cacheDir === null) feedGame(s.game, line);
  if (line.includes("public address ")) s.game.publicAddress = PUBLIC_ADDRESS_RE.exec(line)?.[1] ?? s.game.publicAddress;
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
  feedCollector(s, line, s.start);
  feedBlessed(s.blessed, line, s.start);
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
    const { size, mtimeMs } = await fh.stat();
    const headBuf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    if (headBuf.length) await fh.read(headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString("latin1");
    if (!scan || scan.path !== path || size < scan.offset || !head.startsWith(scan.head)) scan = newScan(path, head);
    const s = scan;
    s.mtime = mtimeMs;
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
  if (r.open) {
    const at = r.open.at ?? r.open.logAt;
    count += 1;
    if (!first) first = at;
    last = Math.max(last, at);
  }
  return count ? { count, first, last } : null;
}

export async function refusalDetails(path?: string): Promise<RefusalDetail[]> {
  const s = await currentScan(path);
  return s ? [...s.refusals.details] : [];
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

export interface LoggedGame {
  log: string;
  build: string | null;
  cacheDir: string | null;
  publicAddress: string | null;
}

export async function loggedGame(path?: string): Promise<LoggedGame | null> {
  const s = await currentScan(path);
  return s ? { log: s.path, build: s.game.build, cacheDir: s.game.cacheDir, publicAddress: s.game.publicAddress } : null;
}

export async function loggedCollector(path?: string): Promise<LoggedCollector | null> {
  const s = await currentScan(path);
  return s?.collector ? { ...s.collector, logAt: s.mtime } : null;
}

export async function loggedBlessed(path?: string): Promise<LoggedBlessed | null> {
  const s = await currentScan(path);
  return s?.blessed.last ? { ...s.blessed.last, logAt: s.mtime } : null;
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
