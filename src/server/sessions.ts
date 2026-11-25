// Play sessions: one per run of the game (one game log). The log gives each
// session's start and end and the dungeons entered; what came into the inventory
// is worked out by comparing SFHelper's inventory reads, so it is only as fine as
// those reads (the game saves its inventory every few minutes).

import { readFile } from "node:fs/promises";
import { appFile, readDataJson } from "./paths";
import { writeFileAtomic } from "./files";
import type { LoggedRun, LoggedSession, LoggedTotem } from "./gameLog";
import { gripOf } from "./loadouts";
import { dungeonName } from "./timers";
import { parseTotems } from "./totems";
import type { TotemDetail } from "./trades";

export interface LootSnapshot {
  counts: Record<string, number>;
  instances: Record<string, string>;
  xp: Record<string, number>;
  pending: Record<string, string>;
  purchases: Record<string, number>;
  totems?: Record<string, TotemDetail>;
}

export interface LootItem {
  id: string;
  key: string;
  totem?: TotemDetail;
}

export interface Loot {
  counts: Record<string, number>;
  items: LootItem[];
  xp: Record<string, number>;
}

export interface PlaySession extends Loot {
  id: number;
  start: number;
  end: number;
  ended: boolean;
  runs: LoggedRun[];
  reads: number;
  // The last inventory read added to this session, and the game's last save in it.
  readAt?: number;
  savedAt?: number | null;
  logTotems?: LoggedTotem[];
}

interface CraftDef {
  result?: string;
  gives?: number;
  fragments?: number;
  consumed?: boolean;
  ingredients?: { type: string; count: number }[];
}

export interface LootContext {
  recipes: Record<string, CraftDef>;
  offers: Record<string, string>;
  traded: boolean;
}

interface State {
  last?: { at: string; session: number | null; snap: LootSnapshot } | undefined;
  sessions: PlaySession[];
}

const COUNTED = ["MiscItems", "RawUpgrades", "Consumables", "Recipes"];
const INSTANCED = ["Melee", "LongGuns", "Pistols", "Suits", "WeaponSkins", "Upgrades"];
// Temper study counts (Tuvalkane's learning) and hairstyles aren't loot.
const SKIP_RE = /\/Types\/Items\/Aspects\/Tempers\/|\/Skins\/Hair\//;
const MAX_SESSIONS = 200;
// A read this soon after logging in still holds what the game saved when the
// previous session ended, so that difference belongs to the previous session.
const CARRY_WINDOW_MS = 15 * 60_000;
// The session's end time is saved at most this often while the game runs.
const END_SAVE_STEP_MS = 60_000;
// Log times come from the game's clock; a save this close to a read counts as read.
const LOG_SKEW_MS = 3_000;

const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const oid = (v: unknown): string | null => {
  const id = (v as { $oid?: unknown } | null)?.$oid;
  return typeof id === "string" && id ? id : null;
};

export function parseLoot(raw: unknown): LootSnapshot {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const bucket of COUNTED) {
    for (const e of list(r[bucket])) {
      if (typeof e.ItemType !== "string" || typeof e.ItemCount !== "number" || SKIP_RE.test(e.ItemType)) continue;
      counts[e.ItemType] = (counts[e.ItemType] ?? 0) + e.ItemCount;
    }
  }
  const instances: Record<string, string> = {};
  for (const bucket of INSTANCED) {
    for (const e of list(r[bucket])) {
      const id = oid(e.ItemId);
      if (id && typeof e.ItemType === "string" && !SKIP_RE.test(e.ItemType)) instances[id] = e.ItemType;
    }
  }
  const xp: Record<string, number> = {};
  for (const e of list(r.XPInfo)) if (typeof e.ItemType === "string" && typeof e.XP === "number") xp[e.ItemType] = e.XP;
  const pending: Record<string, string> = {};
  for (const e of list(r.PendingRecipes)) {
    const id = oid(e.ItemId);
    if (id && typeof e.ItemType === "string") pending[id] = e.ItemType;
  }
  const purchases: Record<string, number> = {};
  for (const v of list(r.RecentVendorPurchases)) {
    for (const p of list(v.PurchaseHistory)) {
      if (typeof p.ItemId === "string" && typeof p.NumPurchased === "number") purchases[p.ItemId] = p.NumPurchased;
    }
  }
  const totems: Record<string, TotemDetail> = {};
  for (const t of parseTotems(r)) totems[t.id] = { virtue: t.virtue, grip: t.grip, rank: t.rank };
  return { counts, instances, xp, pending, purchases, totems };
}

// What came in between two reads. Counted items are net changes, with what a
// craft started in between used up added back. Finished crafts collected and
// Avakot purchases are taken out, and a window with a trade in it adds no items
// (the Trades tab has those).
export function lootBetween(prev: LootSnapshot, next: LootSnapshot, ctx: LootContext): Loot {
  const xp: Record<string, number> = {};
  for (const [k, v] of Object.entries(next.xp)) {
    const d = v - (prev.xp[k] ?? 0);
    if (d > 0) xp[k] = d;
  }
  if (ctx.traded) return { counts: {}, items: [], xp };

  const delta: Record<string, number> = {};
  const add = (k: string, n: number) => (delta[k] = (delta[k] ?? 0) + n);
  for (const k of new Set([...Object.keys(prev.counts), ...Object.keys(next.counts)])) add(k, (next.counts[k] ?? 0) - (prev.counts[k] ?? 0));

  const fresh: LootItem[] = Object.entries(next.instances)
    .filter(([id]) => !(id in prev.instances))
    .map(([id, key]) => {
      const totem = next.totems?.[id];
      return totem ? { id, key, totem } : { id, key };
    });
  const take = (key: string, n: number) => {
    if (key in next.counts || key in prev.counts) return void add(key, -n);
    for (let i = 0; i < n; i++) {
      const at = fresh.findIndex((x) => x.key === key);
      if (at < 0) return;
      fresh.splice(at, 1);
    }
  };

  for (const [id, recipe] of Object.entries(next.pending)) {
    if (id in prev.pending) continue;
    const r = ctx.recipes[recipe];
    for (const ing of r?.ingredients ?? []) add(ing.type, ing.count);
    if (r?.consumed && r.fragments) add(recipe, r.fragments);
  }
  for (const [id, recipe] of Object.entries(prev.pending)) {
    if (id in next.pending) continue;
    const r = ctx.recipes[recipe];
    if (r?.result) take(r.result, r.gives ?? 1);
  }
  for (const [id, n] of Object.entries(next.purchases)) {
    const bought = n - (prev.purchases[id] ?? 0);
    const key = ctx.offers[id];
    if (bought > 0 && key) take(key, bought);
  }

  const counts: Record<string, number> = {};
  for (const [k, d] of Object.entries(delta)) if (d > 0) counts[k] = d;
  return { counts, items: fresh, xp };
}

const statePath = () => appFile("sessions.json");

async function load(): Promise<State> {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8")) as Partial<State>;
    return { last: s.last, sessions: Array.isArray(s.sessions) ? s.sessions : [] };
  } catch {
    return { sessions: [] };
  }
}

async function save(s: State): Promise<void> {
  s.sessions = s.sessions.sort((a, b) => b.id - a.id).slice(0, MAX_SESSIONS);
  await writeFileAtomic(statePath(), JSON.stringify(s));
}

let queue: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

const blank = (id: number, end: number): PlaySession => ({ id, start: id, end, ended: false, runs: [], counts: {}, items: [], xp: {}, reads: 0 });

// Keeps the running game's session (times and dungeon runs) up to date. The
// game starts a new log every launch, so this has to run while it plays.
export function syncPlaySession(log: LoggedSession | null): Promise<void> {
  return queued(async () => {
    if (!log) return;
    const s = await load();
    let p = s.sessions.find((x) => x.id === log.start);
    let changed = false;
    if (!p) {
      p = blank(log.start, log.lastAt);
      s.sessions.push(p);
      changed = true;
    }
    if (log.lastAt - p.end >= END_SAVE_STEP_MS || (log.ended && log.lastAt > p.end)) {
      p.end = log.lastAt;
      changed = true;
    }
    if (log.ended && !p.ended) {
      p.ended = true;
      changed = true;
    }
    if (log.runs.length >= p.runs.length && JSON.stringify(log.runs) !== JSON.stringify(p.runs)) {
      p.runs = log.runs;
      changed = true;
    }
    if (log.savedAt !== null && log.savedAt !== p.savedAt) {
      p.savedAt = log.savedAt;
      changed = true;
    }
    if (log.totems.length > (p.logTotems?.length ?? 0)) {
      p.logTotems = log.totems;
      changed = true;
    }
    for (const o of s.sessions) {
      if (o.id < log.start && !o.ended) {
        o.ended = true;
        changed = true;
      }
    }
    if (changed) await save(s);
  });
}

async function lootContext(traded: boolean): Promise<LootContext> {
  const [recipes, stock] = await Promise.all([
    readDataJson<{ recipes?: Record<string, CraftDef> }>("recipes.json"),
    readFile(appFile("avakot-stock.json"), "utf8").then((t) => JSON.parse(t) as { stock?: { offers?: { id?: unknown; storeItem?: unknown }[] } }).catch(() => null),
  ]);
  const offers: Record<string, string> = {};
  for (const o of stock?.stock?.offers ?? []) {
    if (typeof o.id === "string" && typeof o.storeItem === "string") offers[o.id] = o.storeItem.replace("/SF/StoreItems/", "/SF/");
  }
  return { recipes: recipes?.recipes ?? {}, offers, traded };
}

function merge(p: PlaySession, loot: Loot): void {
  for (const [k, n] of Object.entries(loot.counts)) p.counts[k] = (p.counts[k] ?? 0) + n;
  const have = new Set(p.items.map((x) => x.id));
  for (const x of loot.items) if (!have.has(x.id)) p.items.push(x);
  for (const [k, n] of Object.entries(loot.xp)) p.xp[k] = (p.xp[k] ?? 0) + n;
  p.reads += 1;
}

// Adds what changed since SFHelper's last inventory read to the session it
// happened in. `traded` says a trade was recorded for this same read.
export function recordSessionLoot(snap: LootSnapshot, at: string, traded: boolean, log: LoggedSession | null): Promise<void> {
  return queued(async () => {
    const s = await load();
    if (s.last?.at === at) return;
    const current = log && !log.ended ? log.start : null;
    const prev = s.last;
    s.last = { at, session: current, snap };
    if (!prev || Date.parse(at) <= Date.parse(prev.at)) {
      await save(s);
      return;
    }
    let target = current ?? prev.session;
    if (prev.session !== null && current !== null && prev.session !== current) {
      const sinceLogin = log?.loginAt != null ? Date.parse(at) - log.loginAt : Infinity;
      if (sinceLogin <= CARRY_WINDOW_MS) target = prev.session;
    }
    if (target !== null) {
      let p = s.sessions.find((x) => x.id === target);
      if (!p) {
        p = blank(target, Date.parse(at));
        s.sessions.push(p);
      }
      merge(p, lootBetween(prev.snap, snap, await lootContext(traded)));
      p.readAt = Date.parse(at);
    }
    await save(s);
  });
}

export function playSessions(): Promise<PlaySession[]> {
  return queued(async () => (await load()).sessions);
}

export interface SessionRun extends LoggedRun {
  name: string | null;
}

export type SessionView = Omit<PlaySession, "runs" | "logTotems"> & {
  runs: SessionRun[];
  // Totems the game log says animals gave that no inventory read has shown yet.
  logTotems: LootItem[];
  // Set to the last read when the game saved after it and nothing has read that
  // save since (it comes in with the first read of the next session).
  unreadSince: number | null;
};

const POL_VIRTUE: Record<string, string> = { AP_COURAGE: "Courage", AP_SPIRIT: "Spirit", AP_GRACE: "Grace" };
const isTotem = (key: string) => key.includes("/Upgrades/Totems/");

function loggedTotemItem(t: LoggedTotem): LootItem & { totem: TotemDetail } {
  return {
    id: `log-${t.at}-${t.type}`,
    key: t.type,
    totem: { virtue: (t.pol && POL_VIRTUE[t.pol]) || null, grip: gripOf(t.compat), rank: (t.lvl ?? 0) + 1 },
  };
}

// The log's Totems minus the ones an inventory read has shown: the same Totem,
// Virtue and grip among the session's items, or the next session's when that
// read landed there.
function unreadTotems(sessions: PlaySession[]): Map<number, LootItem[]> {
  const order = [...sessions].sort((a, b) => a.id - b.id);
  const pools = new Map(order.map((p) => [p.id, p.items.filter((i) => isTotem(i.key))]));
  const take = (pool: LootItem[], t: LootItem & { totem: TotemDetail }) => {
    const at = pool.findIndex((i) => i.key === t.key && (!i.totem || (i.totem.virtue === t.totem.virtue && i.totem.grip === t.totem.grip)));
    if (at >= 0) pool.splice(at, 1);
    return at >= 0;
  };
  const left = new Map(order.map((p) => [p.id, (p.logTotems ?? []).map(loggedTotemItem).filter((t) => !take(pools.get(p.id)!, t))]));
  order.forEach((p, i) => {
    const next = order[i + 1];
    if (next) left.set(p.id, left.get(p.id)!.filter((t) => !take(pools.get(next.id)!, t as LootItem & { totem: TotemDetail })));
  });
  return left;
}

// Sessions newest first, with each dungeon run named the way the game names it.
export async function sessionView(): Promise<SessionView[]> {
  const [state, places] = await Promise.all([queued(load), readDataJson<{ dungeons?: Record<string, string> }>("locations.json")]);
  const dungeons = places?.dungeons ?? {};
  const lastRead = state.last ? Date.parse(state.last.at) : 0;
  const totems = unreadTotems(state.sessions);
  const unreadSince = (p: PlaySession): number | null => {
    const read = p.readAt ?? (state.last?.session === p.id ? lastRead : null);
    if (!p.ended || !p.savedAt || read === null || p.savedAt <= read + LOG_SKEW_MS) return null;
    return lastRead > p.end ? null : read;
  };
  return state.sessions.map(({ logTotems: _, ...p }) => ({
    ...p,
    runs: p.runs.map((r) => ({ ...r, name: dungeonName(r.folder, dungeons) })),
    logTotems: totems.get(p.id) ?? [],
    unreadSince: unreadSince(p),
  }));
}

// Sessions from an exported history file; ones already here are kept as they are.
export function importSessions(entries: PlaySession[]): Promise<number> {
  return queued(async () => {
    const s = await load();
    const have = new Set(s.sessions.map((p) => p.id));
    const added = entries.filter((p) => !have.has(p.id));
    if (!added.length) return 0;
    s.sessions.push(...added);
    await save(s);
    return added.length;
  });
}
