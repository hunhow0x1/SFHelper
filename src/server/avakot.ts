import { readFile } from "node:fs/promises";
import { appFile } from "./paths";
import { writeFileAtomic } from "./files";

export const AVAKOT_VENDOR = "/SF/Types/Game/AvakotVendorManifest";
const PERMANENT_AFTER_MS = 365 * 24 * 3600_000;
const REFRESH_GRACE_MS = 30_000;
const MIN_INTERVAL_MS = 10 * 60_000;

export interface AvakotOffer {
  id: string;
  storeItem: string;
  currency: "Dracs" | "Arcs" | null;
  price: number | null;
  limit: number | null;
  weekly: boolean;
  expiry: number | null;
}

export interface AvakotStock {
  fetchedAt: number;
  nextChange: number;
  offers: AvakotOffer[];
}

export interface AvakotSeen {
  count: number;
  last: number;
}

interface AvakotState {
  v: 1;
  stock: AvakotStock | null;
  lastAttempt: number;
  seen: Record<string, AvakotSeen>;
  notified: string[];
}

const statePath = () => appFile("avakot-stock.json");

async function loadState(): Promise<AvakotState> {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8")) as Partial<AvakotState>;
    if (s.v === 1) {
      const stock = s.stock && Array.isArray(s.stock.offers) && Number.isFinite(s.stock.nextChange) ? s.stock : null;
      const lastAttempt = Number.isFinite(s.lastAttempt) ? s.lastAttempt! : 0;
      const seen = s.seen && typeof s.seen === "object" ? s.seen : {};
      return { v: 1, stock, lastAttempt, seen, notified: Array.isArray(s.notified) ? s.notified : [] };
    }
  } catch {
  }
  return { v: 1, stock: null, lastAttempt: 0, seen: {}, notified: [] };
}

async function saveState(s: AvakotState): Promise<void> {
  await writeFileAtomic(statePath(), `${JSON.stringify(s)}\n`);
}

const dateOf = (v: unknown): number | null => {
  const raw = (v as { $date?: { $numberLong?: unknown } } | undefined)?.$date?.$numberLong;
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};
const firstPositive = (v: unknown): number | null =>
  Array.isArray(v) && typeof v[0] === "number" && v[0] > 0 ? v[0] : null;

export function parseVendorInfo(body: string, now = Date.now()): AvakotStock {
  let info: Record<string, unknown> | undefined;
  try {
    info = (JSON.parse(body) as { VendorInfo?: Record<string, unknown> }).VendorInfo;
  } catch {
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
  if (offers.some((o) => o.expiry !== null && o.expiry <= now)) return { fetchedAt: now, nextChange: now, offers };
  const changes = offers.map((o) => o.expiry).filter((e): e is number => e !== null && e > now);
  const top = dateOf(info.Expiry);
  if (top !== null && top > now && top - now <= PERMANENT_AFTER_MS) changes.push(top);
  return { fetchedAt: now, nextChange: changes.length ? Math.min(...changes) : now + 3 * 3600_000, offers };
}

export async function avakotDueAt(): Promise<number> {
  const s = await loadState();
  return Math.max(s.lastAttempt + MIN_INTERVAL_MS, s.stock ? s.stock.nextChange + REFRESH_GRACE_MS : 0);
}

export async function avakotDue(now = Date.now()): Promise<boolean> {
  return now >= (await avakotDueAt());
}

export async function noteAvakotAttempt(now = Date.now()): Promise<void> {
  const s = await loadState();
  s.lastAttempt = now;
  await saveState(s);
}

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

export async function acknowledgeAvakot(watch: readonly string[]): Promise<void> {
  const s = await loadState();
  if (!s.stock) return;
  const watched = new Set(watch);
  const ids = new Set(s.notified);
  for (const o of s.stock.offers) if (watched.has(o.storeItem)) ids.add(o.id);
  s.notified = [...ids];
  await saveState(s);
}

const RESET_NOTICE_MS = 15 * 60_000;

export function stockReset(prev: AvakotStock | null, next: AvakotStock, now = Date.now()): boolean {
  if (!prev || now < prev.nextChange || now - prev.nextChange > RESET_NOTICE_MS) return false;
  const had = new Set(prev.offers.map((o) => o.id));
  return next.offers.some((o) => o.expiry !== null && !had.has(o.id));
}

export async function getAvakot(now = Date.now()): Promise<{ stock: AvakotStock | null; seen: Record<string, AvakotSeen> }> {
  const s = await loadState();
  const stock = s.stock && { ...s.stock, offers: s.stock.offers.filter((o) => o.expiry === null || o.expiry > now) };
  return { stock, seen: s.seen };
}
