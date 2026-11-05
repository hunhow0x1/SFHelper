export const WEAPON_RANK_CONST = 125;
export const PACT_RANK_CONST = 500;
export const MAX_RANK = 30;

export interface OwnedWeapon {
  key: string;
  xp: number;
  slot: "Melee" | "LongGuns" | "Pistols";
  craftwork: string | null;
  tempers: string[];
  id: string | null;
}

function craftworkOf(e: { Quality?: unknown }): string | null {
  return typeof e.Quality === "string" ? e.Quality : null;
}
function tempersOf(e: { AspectFingerprint?: unknown }): string[] {
  const fp = e.AspectFingerprint as { buffs?: unknown } | undefined;
  if (!fp || !Array.isArray(fp.buffs)) return [];
  return fp.buffs
    .map((b) => (b as { Tag?: unknown }).Tag)
    .filter((t): t is string => typeof t === "string");
}

export function affinityForRank(rank: number, perRank = WEAPON_RANK_CONST): number {
  return perRank * rank * rank;
}

export function xpToRank(xp: number, perRank = WEAPON_RANK_CONST): number {
  if (!(xp > 0)) return 0;
  return Math.max(0, Math.min(MAX_RANK, Math.floor(Math.sqrt(xp / perRank))));
}

export interface OwnedPact {
  key: string;
  xp: number;
}

export function parsePacts(raw: unknown): OwnedPact[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>).Suits;
  if (!Array.isArray(list)) return [];
  const byKey = new Map<string, OwnedPact>();
  for (const entry of list) {
    const e = entry as { ItemType?: string; XP?: unknown };
    if (typeof e.ItemType !== "string") continue;
    const xp = typeof e.XP === "number" && Number.isFinite(e.XP) ? e.XP : 0;
    const prev = byKey.get(e.ItemType);
    if (!prev || xp > prev.xp) byKey.set(e.ItemType, { key: e.ItemType, xp });
  }
  return [...byKey.values()];
}

export function parseMastery(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const list = (raw as Record<string, unknown>).XPInfo;
  if (!Array.isArray(list)) return {};
  const out: Record<string, number> = {};
  for (const entry of list) {
    const e = entry as { ItemType?: unknown; XP?: unknown };
    if (typeof e.ItemType !== "string" || typeof e.XP !== "number" || !Number.isFinite(e.XP)) continue;
    out[e.ItemType] = Math.max(out[e.ItemType] ?? 0, e.XP);
  }
  return out;
}

export const TEMPER_LEARN_GOAL = 10;
export interface TemperProgress {
  tag: string;
  count: number;
}
export function parseTemperProgress(raw: unknown): TemperProgress[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>).RawUpgrades;
  if (!Array.isArray(list)) return [];
  const out: TemperProgress[] = [];
  for (const entry of list) {
    const e = entry as { ItemType?: string; ItemCount?: unknown };
    if (typeof e.ItemType !== "string" || !e.ItemType.includes("/Aspects/Tempers/")) continue;
    const tag = e.ItemType.split("/").pop() ?? e.ItemType;
    const count = typeof e.ItemCount === "number" && Number.isFinite(e.ItemCount) ? e.ItemCount : 0;
    out.push({ tag, count });
  }
  return out;
}

export interface WeaponInstance {
  id: string;
  key: string;
  craftwork: string | null;
  tempers: string[];
  xp: number;
  moonsteel: boolean;
  extra?: Record<string, unknown>;
}

const KNOWN_WEAPON_KEYS = new Set([
  "ItemType", "ItemId", "Configs", "XP", "Quality", "AspectType", "AspectFingerprint",
  "UpgradeType", "UpgradeFingerprint", "UpgradeVer", "IgnoreBinCount", "TitleType", "Features",
]);

function moonsteelOf(e: Record<string, unknown>): boolean {
  const truthy = (o: unknown) =>
    !!o && typeof o === "object" &&
    Object.entries(o as Record<string, unknown>).some(([k, v]) => /shiny|moonsteel/i.test(k) && !!v && v !== "0");
  return truthy(e) || truthy(e.AspectFingerprint);
}

const WEAPON_BUCKETS: OwnedWeapon["slot"][] = ["Melee", "LongGuns", "Pistols"];

export function parseWeaponInstances(raw: unknown): WeaponInstance[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const out: WeaponInstance[] = [];
  for (const slot of WEAPON_BUCKETS) {
    const list = record[slot];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = entry as { ItemType?: string; XP?: unknown; Quality?: unknown; AspectFingerprint?: unknown; ItemId?: { $oid?: string } };
      const id = e.ItemId?.$oid;
      if (!id || typeof e.ItemType !== "string") continue;
      const extra = Object.keys(e).filter((k) => !KNOWN_WEAPON_KEYS.has(k));
      out.push({
        id,
        key: e.ItemType,
        craftwork: craftworkOf(e),
        tempers: tempersOf(e),
        xp: typeof e.XP === "number" && Number.isFinite(e.XP) ? e.XP : 0,
        moonsteel: moonsteelOf(e as Record<string, unknown>),
        ...(extra.length ? { extra: Object.fromEntries(extra.map((k) => [k, (e as Record<string, unknown>)[k]])) } : {}),
      });
    }
  }
  return out;
}

export interface AcquisitionContext {
  blueprints: Record<string, number>;
  pending: string[];
  vendorPurchases: number;
  favour?: Record<string, number>;
}
export function parseAcquisitionContext(raw: unknown): AcquisitionContext {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const leaf = (t: string) => t.split("/").pop() ?? t;
  const blueprints: Record<string, number> = {};
  for (const x of Array.isArray(r.Recipes) ? r.Recipes : []) {
    const e = x as { ItemType?: unknown; ItemCount?: unknown };
    if (typeof e.ItemType === "string" && e.ItemType.includes("/Recipes/Weapons/"))
      blueprints[leaf(e.ItemType)] = typeof e.ItemCount === "number" ? e.ItemCount : 0;
  }
  const pending = (Array.isArray(r.PendingRecipes) ? r.PendingRecipes : [])
    .map((x) => (x as { ItemType?: unknown }).ItemType)
    .filter((t): t is string => typeof t === "string" && t.includes("/Recipes/Weapons/"))
    .map(leaf);
  let vendorPurchases = 0;
  for (const v of Array.isArray(r.RecentVendorPurchases) ? r.RecentVendorPurchases : []) {
    const vt = (v as { VendorType?: unknown }).VendorType;
    if (typeof vt === "string" && /Avakot/i.test(vt)) continue;
    for (const h of (v as { PurchaseHistory?: unknown }).PurchaseHistory as unknown[] ?? []) {
      const n = (h as { NumPurchased?: unknown }).NumPurchased;
      if (typeof n === "number") vendorPurchases += n;
    }
  }
  const favour: Record<string, number> = {};
  for (const a of Array.isArray(r.Affiliations) ? r.Affiliations : []) {
    const e = a as { Tag?: unknown; Standing?: unknown };
    if (typeof e.Tag === "string" && typeof e.Standing === "number") favour[e.Tag] = e.Standing;
  }
  return { blueprints, pending, vendorPurchases, favour };
}

export function parseWeapons(raw: unknown): OwnedWeapon[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const byKey = new Map<string, OwnedWeapon>();
  for (const slot of WEAPON_BUCKETS) {
    const list = record[slot];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = entry as { ItemType?: string; XP?: unknown; Quality?: unknown; AspectFingerprint?: unknown; ItemId?: { $oid?: string } };
      if (typeof e.ItemType !== "string") continue;
      const xp = typeof e.XP === "number" && Number.isFinite(e.XP) ? e.XP : 0;
      const prev = byKey.get(e.ItemType);
      if (!prev || xp > prev.xp) {
        byKey.set(e.ItemType, {
          key: e.ItemType,
          xp,
          slot,
          craftwork: craftworkOf(e),
          tempers: tempersOf(e),
          id: e.ItemId?.$oid ?? null,
        });
      }
    }
  }
  return [...byKey.values()];
}
