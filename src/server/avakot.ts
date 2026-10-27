/** Avakot's Gots: the stock of Avakot's travelling shop.
 *
 *  The game asks DE's server for it (getVendorInfo.php, with the login
 *  session's nonce), and so does the desktop app, with the session its
 *  inventory import already found - but only once the last copy has run out.
 *  His materials change every 3 hours, so that's about 8 small requests a day
 *  while the game is running. The browser version has no session and never asks.
 *
 *  The response is { VendorInfo: { TypeName, Expiry, ItemManifest: [{ StoreItem,
 *  RegularPrice: [Dracs, Dracs] | PremiumPrice: [Arcs, Arcs], PurchaseQuantityLimit,
 *  RotatedWeekly, Expiry, Id }] } }. Offers that never change (Life Elixir, Pact
 *  fragments, the weekly Joineries and Lampyrite purses) expire in 2035; the
 *  rotating ones (materials, lures, Lampyrite crates) at their own times, and
 *  each gets a new Id when it rotates in.
 *
 *  Kept in avakot-stock.json in the app's data folder: the last stock, how often
 *  and how recently each item has been offered, and which starred offers were
 *  already notified, so each offer notifies once.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appFile } from "./paths";

export const AVAKOT_VENDOR = "/SF/Types/Game/AvakotVendorManifest";
/** Offers that expire further out than this are permanent (the game uses 2035). */
const PERMANENT_AFTER_MS = 365 * 24 * 3600_000;
/** Ask this long after the stock should have changed, for clock drift. */
const REFRESH_GRACE_MS = 30_000;
/** Never ask more often than this, whatever the expiry times say. */
const MIN_INTERVAL_MS = 10 * 60_000;

export interface AvakotOffer {
  /** New each time an item rotates in. */
  id: string;
  storeItem: string;
  currency: "Dracs" | "Arcs" | null;
  price: number | null;
  /** Purchase limit (per offer, or per week for weekly ones); null = none. */
  limit: number | null;
  weekly: boolean;
  /** When the offer leaves (ms epoch); null if it's always there. */
  expiry: number | null;
}

export interface AvakotStock {
  fetchedAt: number;
  /** When the stock next changes: the earliest rotating expiry. */
  nextChange: number;
  offers: AvakotOffer[];
}

export interface AvakotSeen {
  /** Separate times the item has been offered. */
  count: number;
  /** When its most recent offer ends or ended (ms epoch). */
  last: number;
}

interface AvakotState {
  v: 1;
  stock: AvakotStock | null;
  lastAttempt: number;
  /** storeItem -> history of its rotating offers. */
  seen: Record<string, AvakotSeen>;
  /** Offer ids already notified (or already in stock when starred). */
  notified: string[];
}

const statePath = () => appFile("avakot-stock.json");

async function loadState(): Promise<AvakotState> {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8")) as Partial<AvakotState>;
    if (s.v === 1) {
      return { v: 1, stock: s.stock ?? null, lastAttempt: s.lastAttempt ?? 0, seen: s.seen ?? {}, notified: s.notified ?? [] };
    }
  } catch {
    // none yet
  }
  return { v: 1, stock: null, lastAttempt: 0, seen: {}, notified: [] };
}

async function saveState(s: AvakotState): Promise<void> {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), `${JSON.stringify(s)}\n`);
}

const dateOf = (v: unknown): number | null => {
  const raw = (v as { $date?: { $numberLong?: unknown } } | undefined)?.$date?.$numberLong;
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};
const firstPositive = (v: unknown): number | null =>
  Array.isArray(v) && typeof v[0] === "number" && v[0] > 0 ? v[0] : null;

/** Read a getVendorInfo.php response for Avakot. Throws if it isn't one. */
export function parseVendorInfo(body: string, now = Date.now()): AvakotStock {
  let info: Record<string, unknown> | undefined;
  try {
    info = (JSON.parse(body) as { VendorInfo?: Record<string, unknown> }).VendorInfo;
  } catch {
    // reported below
  }
  if (!info || info.TypeName !== AVAKOT_VENDOR || !Array.isArray(info.ItemManifest)) {
    throw new Error(`unexpected vendor response (${body.length} bytes)`);
  }
  const offers: AvakotOffer[] = [];
  for (const raw of info.ItemManifest as Record<string, unknown>[]) {
    if (typeof raw?.StoreItem !== "string") continue;
    const dracs = firstPositive(raw.RegularPrice);
    const arcs = firstPositive(raw.PremiumPrice);
    const expiry = dateOf(raw.Expiry);
    const id = (raw.Id as { $oid?: unknown } | undefined)?.$oid;
    const limit = raw.PurchaseQuantityLimit;
    offers.push({
      id: typeof id === "string" ? id : `${raw.StoreItem}@${expiry}`,
      storeItem: raw.StoreItem,
      currency: dracs ? "Dracs" : arcs ? "Arcs" : null,
      price: dracs ?? arcs,
      limit: typeof limit === "number" && limit > 0 ? limit : null,
      weekly: raw.RotatedWeekly === true,
      expiry: expiry === null || expiry - now > PERMANENT_AFTER_MS ? null : expiry,
    });
  }
  // An offer that has already ended means DE hadn't rotated the stock yet:
  // ask again (MIN_INTERVAL_MS later) instead of waiting for the next change.
  if (offers.some((o) => o.expiry !== null && o.expiry <= now)) return { fetchedAt: now, nextChange: now, offers };
  const changes = offers.map((o) => o.expiry).filter((e): e is number => e !== null && e > now);
  const top = dateOf(info.Expiry);
  if (top !== null && top > now && top - now <= PERMANENT_AFTER_MS) changes.push(top);
  return { fetchedAt: now, nextChange: changes.length ? Math.min(...changes) : now + 3 * 3600_000, offers };
}

/** When it's next time to ask for the stock (ms epoch; in the past if it's due now). */
export async function avakotDueAt(): Promise<number> {
  const s = await loadState();
  return Math.max(s.lastAttempt + MIN_INTERVAL_MS, s.stock ? s.stock.nextChange + REFRESH_GRACE_MS : 0);
}

/** Whether it's time to ask for the stock again. */
export async function avakotDue(now = Date.now()): Promise<boolean> {
  return now >= (await avakotDueAt());
}

/** Note an attempt before sending it, so a failure doesn't retry straight away. */
export async function noteAvakotAttempt(now = Date.now()): Promise<void> {
  const s = await loadState();
  s.lastAttempt = now;
  await saveState(s);
}

/** Save a fetched stock. Returns the rotating offers of starred items that
 *  haven't been notified yet; each offer is returned once. */
export async function recordAvakot(stock: AvakotStock, watch: readonly string[]): Promise<AvakotOffer[]> {
  const s = await loadState();
  const before = new Set(s.stock?.offers.map((o) => o.id) ?? []);
  for (const o of stock.offers) {
    if (o.expiry === null) continue;
    const seen = s.seen[o.storeItem] ?? { count: 0, last: 0 };
    s.seen[o.storeItem] = { count: seen.count + (before.has(o.id) ? 0 : 1), last: Math.max(seen.last, o.expiry) };
  }
  const watched = new Set(watch);
  const notified = new Set(s.notified);
  const fresh = stock.offers.filter((o) => o.expiry !== null && watched.has(o.storeItem) && !notified.has(o.id));
  const current = new Set(stock.offers.map((o) => o.id));
  s.notified = [...s.notified.filter((id) => current.has(id)), ...fresh.map((o) => o.id)];
  s.stock = stock;
  await saveState(s);
  return fresh;
}

/** The user changed their stars: offers already in stock count as notified,
 *  so starring something you can already see doesn't notify about it later. */
export async function acknowledgeAvakot(watch: readonly string[]): Promise<void> {
  const s = await loadState();
  if (!s.stock) return;
  const watched = new Set(watch);
  const ids = new Set(s.notified);
  for (const o of s.stock.offers) if (watched.has(o.storeItem)) ids.add(o.id);
  s.notified = [...ids];
  await saveState(s);
}

/** For the dashboard: the last stock without offers that have since ended, and
 *  the offer history. */
export async function getAvakot(now = Date.now()): Promise<{ stock: AvakotStock | null; seen: Record<string, AvakotSeen> }> {
  const s = await loadState();
  const stock = s.stock && { ...s.stock, offers: s.stock.offers.filter((o) => o.expiry === null || o.expiry > now) };
  return { stock, seen: s.seen };
}
