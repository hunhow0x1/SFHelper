import { readFile } from "node:fs/promises";
import { appFile } from "./paths";
import { logTrades, type LoggedTrade } from "./gameLog";
import { parseWeaponInstances } from "./weapons";
import { writeFileAtomic } from "./files";

const INSTANCE_BUCKETS = ["Melee", "LongGuns", "Pistols", "WeaponSkins", "Upgrades"];
const COUNT_BUCKETS = ["MiscItems", "RawUpgrades"];
const UNTRADABLE_RE = /\/Skins\/(Hair|Sparrow)\//;
const MAX_HISTORY = 500;
const LOG_SKEW_MS = 5_000;

export interface WeaponDetail {
  craftwork: string | null;
  tempers: string[];
  moonsteel: boolean;
}

export interface Holdings {
  instances: Record<string, string>;
  weapons?: Record<string, WeaponDetail>;
  counts: Record<string, number>;
  dracs: number | null;
  tradesRemaining: number | null;
  envoyRank: number | null;
  nextRefill?: number | null;
}

export interface TradeItem {
  key: string;
  count: number;
  ids?: string[];
  weapon?: WeaponDetail;
}

export interface Deal {
  when: string;
  partner: string | null;
  offered: string[];
  received: string[];
}

export interface Trade {
  at: string;
  after: string;
  count: number;
  received: TradeItem[];
  given: TradeItem[];
  dracs: number;
  deals?: Deal[];
  logOnly?: boolean;
}

export interface TradesView {
  history: Trade[];
  remaining: number | null;
  max: number | null;
}

interface State {
  last?: { at: string; holdings: Holdings } | undefined;
  peak?: { day: string; remaining: number } | undefined;
  history: Trade[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const dateOf = (v: unknown): number | null => {
  const n = Number((v as { $date?: { $numberLong?: unknown } } | null)?.$date?.$numberLong);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function parseHoldings(raw: unknown): Holdings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const instances: Record<string, string> = {};
  for (const bucket of INSTANCE_BUCKETS) {
    for (const x of Array.isArray(r[bucket]) ? (r[bucket] as unknown[]) : []) {
      const e = x as { ItemType?: unknown; ItemId?: { $oid?: unknown } };
      const id = e.ItemId?.$oid;
      if (typeof e.ItemType === "string" && typeof id === "string" && !UNTRADABLE_RE.test(e.ItemType)) instances[id] = e.ItemType;
    }
  }
  const weapons: Record<string, WeaponDetail> = {};
  for (const w of parseWeaponInstances(raw)) weapons[w.id] = { craftwork: w.craftwork, tempers: w.tempers, moonsteel: w.moonsteel };
  const counts: Record<string, number> = {};
  for (const bucket of COUNT_BUCKETS) {
    for (const x of Array.isArray(r[bucket]) ? (r[bucket] as unknown[]) : []) {
      const e = x as { ItemType?: unknown; ItemCount?: unknown };
      const n = num(e.ItemCount);
      if (typeof e.ItemType === "string" && n !== null) counts[e.ItemType] = (counts[e.ItemType] ?? 0) + n;
    }
  }
  return {
    instances,
    weapons,
    counts,
    dracs: num(r.RegularCredits),
    tradesRemaining: num(r.TradesRemaining),
    envoyRank: num(r.PlayerLevel),
    nextRefill: dateOf(r.NextRefill),
  };
}

const utcDay = (iso: string): string => iso.slice(0, 10);
const nextReset = (iso: string): number => {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};
const allowance = (h: Holdings): number | null => (h.envoyRank !== null ? h.envoyRank + 1 : null);

export function tradesBetween(prev: Holdings, prevAt: string, next: Holdings, nextAt: string): number {
  if (next.tradesRemaining === null || prev.tradesRemaining === null) return 0;
  const samePeriod = (prev.nextRefill || nextReset(prevAt)) === (next.nextRefill || nextReset(nextAt));
  const base = samePeriod ? prev.tradesRemaining : allowance(next);
  return base === null ? 0 : Math.max(0, base - next.tradesRemaining);
}

export function diffHoldings(prev: Holdings, next: Holdings): { received: TradeItem[]; given: TradeItem[] } {
  const received = new Map<string, TradeItem>();
  const given = new Map<string, TradeItem>();
  const add = (m: Map<string, TradeItem>, key: string, count: number, id?: string, weapon?: WeaponDetail) => {
    if (id && weapon) {
      m.set(id, { key, count: 1, ids: [id], weapon });
      return;
    }
    const t = m.get(key) ?? { key, count: 0 };
    t.count += count;
    if (id) (t.ids ??= []).push(id);
    m.set(key, t);
  };
  for (const [id, key] of Object.entries(next.instances)) if (!(id in prev.instances)) add(received, key, 1, id, next.weapons?.[id]);
  for (const [id, key] of Object.entries(prev.instances)) if (!(id in next.instances)) add(given, key, 1, id, prev.weapons?.[id]);
  for (const key of new Set([...Object.keys(prev.counts), ...Object.keys(next.counts)])) {
    const d = (next.counts[key] ?? 0) - (prev.counts[key] ?? 0);
    if (d > 0) add(received, key, d);
    else if (d < 0) add(given, key, -d);
  }
  return { received: [...received.values()], given: [...given.values()] };
}

function sameOwner(prev: Holdings, next: Holdings): boolean {
  const ids = Object.keys(prev.instances);
  if (ids.length < 10) return true;
  return ids.filter((id) => id in next.instances).length >= ids.length / 2;
}

export function detectTrade(prev: Holdings, prevAt: string, next: Holdings, nextAt: string): Trade | null {
  const count = tradesBetween(prev, prevAt, next, nextAt);
  if (!count || !sameOwner(prev, next)) return null;
  const { received, given } = diffHoldings(prev, next);
  return {
    at: nextAt,
    after: prevAt,
    count,
    received,
    given,
    dracs: next.dracs !== null && prev.dracs !== null ? next.dracs - prev.dracs : 0,
  };
}

export function attachDeals(history: Trade[], logged: LoggedTrade[], latestAt: string): Trade[] {
  const seen = new Set(history.flatMap((t) => (t.deals ?? []).map((d) => d.when)));
  const out = [...history];
  for (const l of logged) {
    const deal: Deal = { when: new Date(l.at).toISOString(), partner: l.partner, offered: l.offered, received: l.received };
    if (seen.has(deal.when) || l.at > Date.parse(latestAt) + LOG_SKEW_MS) continue;
    seen.add(deal.when);
    const home = out.find(
      (t) => !t.logOnly && l.at > Date.parse(t.after) - LOG_SKEW_MS && l.at <= Date.parse(t.at) + LOG_SKEW_MS,
    );
    if (home) home.deals = [...(home.deals ?? []), deal].sort((a, b) => a.when.localeCompare(b.when));
    else out.push({ at: deal.when, after: deal.when, count: 1, received: [], given: [], dracs: 0, deals: [deal], logOnly: true });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export function dailyTrades(h: Holdings, peak: State["peak"], at: string): number | null {
  const base = allowance(h);
  const seen = peak && peak.day === utcDay(at) ? peak.remaining : null;
  return base === null ? seen : Math.max(base, seen ?? 0);
}

export function remainingToday(h: Holdings, at: string, now = new Date().toISOString()): number | null {
  if (h.nextRefill ? h.nextRefill <= Date.parse(now) : utcDay(at) !== utcDay(now)) return allowance(h);
  return h.tradesRemaining;
}

const statePath = () => appFile("trades.json");

async function load(): Promise<State> {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8")) as Partial<State>;
    return { last: s.last, peak: s.peak, history: Array.isArray(s.history) ? s.history : [] };
  } catch {
    return { history: [] };
  }
}

async function save(s: State): Promise<void> {
  await writeFileAtomic(statePath(), JSON.stringify(s));
}

export function tradedIds(history: Trade[]): Set<string> {
  const out = new Set<string>();
  for (const t of history) for (const r of t.received) for (const id of r.ids ?? []) out.add(id);
  return out;
}

let queue: Promise<unknown> = Promise.resolve();

function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

export function tradeHistory(): Promise<Trade[]> {
  return queued(async () => (await load()).history);
}

export function importTrades(entries: Trade[]): Promise<number> {
  return queued(async () => {
    const s = await load();
    const have = new Set(s.history.map((t) => t.at));
    const added: Trade[] = [];
    for (const t of entries) {
      if (have.has(t.at)) continue;
      have.add(t.at);
      added.push(t);
    }
    if (!added.length) return 0;
    s.history = [...s.history, ...added].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_HISTORY);
    await save(s);
    return added.length;
  });
}

export function recordTrades(h: Holdings, at: string, readLog: () => Promise<LoggedTrade[]> = logTrades): Promise<TradesView> {
  return queued(async (): Promise<TradesView> => {
    const s = await load();
    if (!s.last || s.last.at !== at) {
      const trade = s.last && Date.parse(at) > Date.parse(s.last.at) ? detectTrade(s.last.holdings, s.last.at, h, at) : null;
      let history = trade ? [trade, ...s.history] : s.history;
      try {
        history = attachDeals(history, await readLog(), at);
      } catch {
      }
      for (const t of history) {
        for (const i of t.received) {
          const owned = !i.weapon && i.ids?.length === 1 ? h.weapons?.[i.ids[0]!] : undefined;
          if (owned) i.weapon = owned;
        }
      }
      s.history = history.slice(0, MAX_HISTORY);
      s.last = { at, holdings: h };
      const day = utcDay(at);
      if (h.tradesRemaining !== null && (s.peak?.day !== day || h.tradesRemaining > s.peak.remaining)) s.peak = { day, remaining: h.tradesRemaining };
      await save(s);
    }
    return { history: s.history, remaining: remainingToday(h, at), max: dailyTrades(h, s.peak, at) };
  });
}
