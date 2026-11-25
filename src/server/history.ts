import { importPickups, pickupHistory, type Pickup, type PickupSource } from "./pickups";
import { importTrades, tradeHistory, type Deal, type Trade, type TotemDetail, type TradeItem, type WeaponDetail } from "./trades";
import { rememberedAgari } from "./timers";
import { importSessions, playSessions, type LootItem, type PlaySession } from "./sessions";
import type { LoggedRun, LoggedTotem } from "./gameLog";

export interface HistoryFile {
  app: "SFHelper";
  kind: "history";
  version: 1;
  exportedAt: string;
  pickups: Pickup[];
  trades: Trade[];
  sessions?: PlaySession[];
  agari: Record<string, string>;
}

export interface ImportResult {
  pickups: number;
  trades: number;
  sessions: number;
  agari: number;
  skipped: number;
}

const KEY_RE = /^\/[A-Za-z0-9_/]+$/;
const ID_RE = /^[0-9a-f]{24}$/i;
const TAG_RE = /^[A-Za-z0-9_]+$/;
const SPOT_RE = /^[A-Za-z0-9_-]+$/;
const AGENT_RE = /^(?:[A-Za-z0-9_]+\/)?[A-Za-z0-9_]+Agent$/;
const MAX_TEXT = 200;
const SOURCES: PickupSource[] = ["pickup", "crafted", "purchased", "traded"];
const WHEN_SOURCES = ["log", "server", "import"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_TEXT;

function time(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function tags(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && TAG_RE.test(x)) ? [...(v as string[])] : null;
}

function weaponDetail(v: unknown): WeaponDetail | null {
  if (!isObj(v)) return null;
  const craftwork = v.craftwork === null ? null : typeof v.craftwork === "string" && TAG_RE.test(v.craftwork) ? v.craftwork : undefined;
  const tempers = tags(v.tempers);
  if (craftwork === undefined || !tempers || typeof v.moonsteel !== "boolean") return null;
  return { craftwork, tempers, moonsteel: v.moonsteel };
}

function pickup(v: unknown): Pickup | null {
  if (!isObj(v) || typeof v.id !== "string" || !ID_RE.test(v.id) || typeof v.key !== "string" || !KEY_RE.test(v.key)) return null;
  const weapon = weaponDetail(v);
  const at = time(v.at);
  const xp = num(v.xp);
  if (!weapon || !at || xp === null) return null;
  const out: Pickup = { id: v.id, key: v.key, craftwork: weapon.craftwork, tempers: weapon.tempers, xp, moonsteel: weapon.moonsteel, at };
  const when = time(v.when);
  const whenSource = WHEN_SOURCES.find((s) => s === v.whenSource);
  if (when && whenSource) {
    out.when = when;
    out.whenSource = whenSource;
  }
  const source = SOURCES.find((s) => s === v.source);
  if (source) out.source = source;
  return out;
}

function tradeItem(v: unknown): TradeItem | null {
  if (!isObj(v) || typeof v.key !== "string" || !KEY_RE.test(v.key)) return null;
  const count = num(v.count);
  if (count === null || count <= 0) return null;
  const out: TradeItem = { key: v.key, count };
  if (v.ids !== undefined) {
    if (!Array.isArray(v.ids) || !v.ids.every((id) => typeof id === "string" && ID_RE.test(id))) return null;
    out.ids = [...(v.ids as string[])];
  }
  if (v.weapon !== undefined) {
    const weapon = weaponDetail(v.weapon);
    if (!weapon) return null;
    out.weapon = weapon;
  }
  return out;
}

function names(v: unknown): string[] | null {
  return Array.isArray(v) && v.every(text) ? [...(v as string[])] : null;
}

function deal(v: unknown): Deal | null {
  if (!isObj(v)) return null;
  const when = time(v.when);
  const offered = names(v.offered);
  const received = names(v.received);
  if (!when || !offered || !received || (v.partner !== null && !text(v.partner))) return null;
  return { when, partner: v.partner, offered, received };
}

function every<T>(v: unknown, read: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const r = read(x);
    if (!r) return null;
    out.push(r);
  }
  return out;
}

function trade(v: unknown): Trade | null {
  if (!isObj(v)) return null;
  const at = time(v.at);
  const after = time(v.after);
  const count = num(v.count);
  const dracs = num(v.dracs);
  const received = every(v.received, tradeItem);
  const given = every(v.given, tradeItem);
  if (!at || !after || count === null || count < 0 || dracs === null || !received || !given) return null;
  const out: Trade = { at, after, count, received, given, dracs };
  if (v.deals !== undefined) {
    const deals = every(v.deals, deal);
    if (!deals) return null;
    out.deals = deals;
  }
  if (v.logOnly === true) out.logOnly = true;
  return out;
}

const FOLDER_RE = /^\w{1,80}$/;

function counts(v: unknown): Record<string, number> | null {
  if (!isObj(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    const c = num(n);
    if (!KEY_RE.test(k) || c === null || c < 0) return null;
    out[k] = c;
  }
  return out;
}

function run(v: unknown): LoggedRun | null {
  if (!isObj(v) || typeof v.folder !== "string" || !FOLDER_RE.test(v.folder) || typeof v.level !== "string" || !FOLDER_RE.test(v.level)) return null;
  const start = num(v.start);
  const end = v.end === null ? null : num(v.end);
  if (start === null || (v.end !== null && end === null)) return null;
  return { folder: v.folder, level: v.level, start, end };
}

const VIRTUES = ["Courage", "Spirit", "Grace"];
const GRIP_RE = /^[A-Za-z' -]{1,40}$/;

function totemDetail(v: unknown): TotemDetail | null {
  if (!isObj(v)) return null;
  const rank = num(v.rank);
  const virtue = v.virtue === null ? null : typeof v.virtue === "string" && VIRTUES.includes(v.virtue) ? v.virtue : undefined;
  if (virtue === undefined || typeof v.grip !== "string" || !GRIP_RE.test(v.grip) || rank === null || rank < 1 || rank > 10) return null;
  return { virtue, grip: v.grip, rank };
}

function lootItem(v: unknown): LootItem | null {
  if (!isObj(v) || typeof v.id !== "string" || !ID_RE.test(v.id) || typeof v.key !== "string" || !KEY_RE.test(v.key)) return null;
  if (v.totem === undefined) return { id: v.id, key: v.key };
  const totem = totemDetail(v.totem);
  return totem ? { id: v.id, key: v.key, totem } : null;
}

function loggedTotem(v: unknown): LoggedTotem | null {
  if (!isObj(v) || typeof v.type !== "string" || !KEY_RE.test(v.type)) return null;
  const at = num(v.at);
  const lvl = v.lvl === null ? null : num(v.lvl);
  const pol = v.pol === null ? null : typeof v.pol === "string" && TAG_RE.test(v.pol) ? v.pol : undefined;
  const compat = v.compat === null ? null : typeof v.compat === "string" && KEY_RE.test(v.compat) ? v.compat : undefined;
  if (at === null || (v.lvl !== null && lvl === null) || pol === undefined || compat === undefined) return null;
  return { at, type: v.type, pol, compat, lvl };
}

function playSession(v: unknown): PlaySession | null {
  if (!isObj(v)) return null;
  const id = num(v.id);
  const start = num(v.start);
  const end = num(v.end);
  const reads = num(v.reads);
  const runs = every(v.runs, run);
  const items = every(v.items, lootItem);
  const got = counts(v.counts);
  const xp = counts(v.xp);
  if (id === null || start === null || end === null || reads === null || typeof v.ended !== "boolean" || !runs || !items || !got || !xp) return null;
  const out: PlaySession = { id, start, end, ended: v.ended, runs, counts: got, items, xp, reads };
  const readAt = num(v.readAt);
  const savedAt = num(v.savedAt);
  if (readAt !== null) out.readAt = readAt;
  if (savedAt !== null) out.savedAt = savedAt;
  if (v.logTotems !== undefined) {
    const logTotems = every(v.logTotems, loggedTotem);
    if (!logTotems) return null;
    out.logTotems = logTotems;
  }
  return out;
}

function agariSpots(v: unknown): Record<string, string> {
  if (!isObj(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => SPOT_RE.test(e[0]) && typeof e[1] === "string" && AGENT_RE.test(e[1])));
}

export async function exportHistory(now = new Date()): Promise<HistoryFile> {
  const [pickups, trades, sessions, agari] = await Promise.all([pickupHistory(), tradeHistory(), playSessions(), rememberedAgari({})]);
  return {
    app: "SFHelper",
    kind: "history",
    version: 1,
    exportedAt: now.toISOString(),
    pickups: pickups.map(({ extra: _extra, ...p }) => p),
    trades,
    sessions,
    agari: { ...agari },
  };
}

export function historyFileName(now = new Date()): string {
  return `sfhelper-history-${now.toISOString().slice(0, 10)}.json`;
}

export async function importHistory(raw: unknown): Promise<ImportResult> {
  if (!isObj(raw) || raw.app !== "SFHelper" || raw.kind !== "history") throw new Error("That isn't an SFHelper history file.");
  if (raw.version !== 1) throw new Error("That history file is from a newer SFHelper. Update SFHelper, then import it again.");
  const pickupsIn = list(raw.pickups);
  const tradesIn = list(raw.trades);
  const sessionsIn = list(raw.sessions);
  const pickups = pickupsIn.map(pickup).filter((p): p is Pickup => !!p);
  const trades = tradesIn.map(trade).filter((t): t is Trade => !!t);
  const sessions = sessionsIn.map(playSession).filter((p): p is PlaySession => !!p);
  const spots = agariSpots(raw.agari);
  const before = await rememberedAgari({});
  const newSpots = Object.keys(spots).filter((k) => before[k] !== spots[k]).length;
  const [addedPickups, addedTrades, addedSessions] = await Promise.all([importPickups(pickups), importTrades(trades), importSessions(sessions)]);
  if (newSpots) await rememberedAgari(spots);
  return {
    pickups: addedPickups,
    trades: addedTrades,
    sessions: addedSessions,
    agari: newSpots,
    skipped: pickupsIn.length - pickups.length + tradesIn.length - trades.length + sessionsIn.length - sessions.length,
  };
}
