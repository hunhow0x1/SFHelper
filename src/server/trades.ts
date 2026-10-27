/** Trade history via inventory diff, named and timed from the game log.
 *
 *  The inventory keeps no trade history, only today's counter: TradesRemaining
 *  starts each day (00:00 UTC) at Envoy Rank + 1 and drops by one per trade.
 *  So we keep the previous import's tradable holdings and, whenever the counter
 *  drops between two imports, record what changed hands:
 *    - instanced items (weapons, armour, talismans, runes, totems) by ItemId,
 *      which an item keeps through a trade: new ids were received, vanished
 *      ids were given;
 *    - stacked items (materials, Joineries) by count.
 *  Each side pays Scutage in Dracs on what it receives (220 / 440 / 880 per item
 *  by rarity, for every unit of a stack: 95 Lampyrite cost 83,600), so the
 *  Dracs change is recorded too.
 *
 *  The game log adds the partner's name and the exact time (see logTrades in
 *  gameLog.ts). It also covers trades made earlier in the same game session,
 *  before SFHelper first saw the inventory; those are recorded from the log
 *  alone, with in-game names but no counts or Dracs.
 *
 *  Limits: the log is rewritten each launch, so trades from a game session
 *  SFHelper never saw are lost. Trades made between the same two imports
 *  (about 2 minutes apart) share one entry, and anything else gained or spent
 *  in that window lands in it as well.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { appFile } from "./paths";
import { logTrades, type LoggedTrade } from "./gameLog";
import { parseWeaponInstances } from "./weapons";

/** Inventory arrays of individually tracked items (each has an ItemId). */
const INSTANCE_BUCKETS = ["Melee", "LongGuns", "Pistols", "WeaponSkins", "Upgrades"];
/** Inventory arrays of stacked items (ItemType + ItemCount). */
const COUNT_BUCKETS = ["MiscItems", "RawUpgrades"];
/** Skins that are appearance only and can't be traded. */
const UNTRADABLE_RE = /\/Skins\/(Hair|Sparrow)\//;
const MAX_HISTORY = 500;
/** Allowed gap between the log's clock and an import's file time. */
const LOG_SKEW_MS = 5_000;

/** What sets one weapon apart from another of its kind. */
export interface WeaponDetail {
  craftwork: string | null;
  tempers: string[];
  moonsteel: boolean;
}

/** The tradable part of an inventory, plus the trade counter. */
export interface Holdings {
  /** ItemId -> ItemType for instanced items. */
  instances: Record<string, string>;
  /** Weapon ItemId -> its craftwork and tempers, to describe traded weapons. */
  weapons?: Record<string, WeaponDetail>;
  /** ItemType -> count for stacked items. */
  counts: Record<string, number>;
  dracs: number | null;
  tradesRemaining: number | null;
  envoyRank: number | null;
}

export interface TradeItem {
  key: string;
  count: number;
  /** Instance ids, for weapons and other instanced items. */
  ids?: string[];
  /** A weapon is listed on its own, with what sets it apart. */
  weapon?: WeaponDetail;
}

/** One trade as the game log tells it: when, with whom, and in-game names. */
export interface Deal {
  when: string;
  partner: string | null;
  offered: string[];
  received: string[];
}

export interface Trade {
  /** ISO time of the import that showed the trade (a log-only entry: the trade's time). */
  at: string;
  /** ISO time of the import before it: the trade happened in between. */
  after: string;
  /** Trades this entry covers (the counter's drop). */
  count: number;
  received: TradeItem[];
  given: TradeItem[];
  /** Change in Dracs over the window (negative: spent, mostly on Scutage). */
  dracs: number;
  /** The game log's record of each trade in this entry, when it had one. */
  deals?: Deal[];
  /** Recorded from the game log alone, before SFHelper saw the inventory. */
  logOnly?: boolean;
}

export interface TradesView {
  history: Trade[];
  /** Trades left today, and the daily allowance (Envoy Rank + 1). */
  remaining: number | null;
  max: number | null;
}

interface State {
  last?: { at: string; holdings: Holdings } | undefined;
  history: Trade[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

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
  };
}

const utcDay = (iso: string): string => iso.slice(0, 10);
/** The daily allowance: Envoy Rank + 1. */
const allowance = (h: Holdings): number | null => (h.envoyRank !== null ? h.envoyRank + 1 : null);

/** How many trades happened between two imports. The counter refills at the
 *  daily reset, so across one the baseline is the full allowance. */
export function tradesBetween(prev: Holdings, prevAt: string, next: Holdings, nextAt: string): number {
  if (next.tradesRemaining === null || prev.tradesRemaining === null) return 0;
  const base = utcDay(prevAt) === utcDay(nextAt) ? prev.tradesRemaining : allowance(next);
  return base === null ? 0 : Math.max(0, base - next.tradesRemaining);
}

/** What changed hands between two holdings. Weapons are listed one by one. */
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

/** False when most items changed: a different account's inventory, not a trade. */
function sameOwner(prev: Holdings, next: Holdings): boolean {
  const ids = Object.keys(prev.instances);
  if (ids.length < 10) return true;
  return ids.filter((id) => id in next.instances).length >= ids.length / 2;
}

/** The trade entry for two adjacent imports, or null if no trade happened. */
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

/** Give each logged trade a place in the history, once: the entry whose import
 *  window holds it, else (for one before the latest import) an entry of its
 *  own. A trade after the latest import waits for the next import's diff.
 *  Returns the history, newest first. */
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

/** Trades left today as of `now`: the import's counter, or the full
 *  allowance if the import predates today's reset. */
export function remainingToday(h: Holdings, at: string, now = new Date().toISOString()): number | null {
  if (utcDay(at) !== utcDay(now)) return allowance(h);
  return h.tradesRemaining;
}

// --- persistence -----------------------------------------------------------------

const statePath = () => appFile("trades.json");

async function load(): Promise<State> {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8")) as Partial<State>;
    return { last: s.last, history: Array.isArray(s.history) ? s.history : [] };
  } catch {
    return { history: [] };
  }
}

async function save(s: State): Promise<void> {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(s));
}

/** Weapon ids received in a trade, so the pickup tracker doesn't count them. */
export function tradedIds(history: Trade[]): Set<string> {
  const out = new Set<string>();
  for (const t of history) for (const r of t.received) for (const id of r.ids ?? []) out.add(id);
  return out;
}

// Imports are diffed on page requests, which can overlap; run one at a time.
let queue: Promise<unknown> = Promise.resolve();

/** Diff this import against the previous one and record any trade. `at` is the
 *  import's time (inventory.json's mtime); an import already seen is a no-op. */
export function recordTrades(h: Holdings, at: string, readLog: () => Promise<LoggedTrade[]> = logTrades): Promise<TradesView> {
  const run = queue.then(async (): Promise<TradesView> => {
    const s = await load();
    if (!s.last || s.last.at !== at) {
      const trade = s.last && Date.parse(at) > Date.parse(s.last.at) ? detectTrade(s.last.holdings, s.last.at, h, at) : null;
      let history = trade ? [trade, ...s.history] : s.history;
      try {
        history = attachDeals(history, await readLog(), at);
      } catch {
        // The log is a bonus; never let it break trade tracking.
      }
      // Entries recorded before weapon details were kept: fill in received
      // weapons that are still owned.
      for (const t of history) {
        for (const i of t.received) {
          const owned = !i.weapon && i.ids?.length === 1 ? h.weapons?.[i.ids[0]!] : undefined;
          if (owned) i.weapon = owned;
        }
      }
      s.history = history.slice(0, MAX_HISTORY);
      s.last = { at, holdings: h };
      await save(s);
    }
    return { history: s.history, remaining: remainingToday(h, at), max: allowance(h) };
  });
  queue = run.catch(() => undefined);
  return run;
}
