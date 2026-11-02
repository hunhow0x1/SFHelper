import {
  SNAPSHOT_SCHEMA_VERSION,
  emptySnapshot,
  type AccountSnapshot,
  type ItemStack,
  type ProgressionEntry,
  type SourceRef,
} from "../snapshot";
import { hashAccountId } from "../identity";

const PROVIDER_ID = "json-import";
const MAX_UNWRAP_DEPTH = 6;
const ENVELOPE_KEYS = ["data", "payload", "inventory", "Inventory", "InventoryJson", "account"];
const ITEM_ARRAY_KEYS = [
  "items",
  "Items",
  "inventory",
  "MiscItems",
  "Suits",
  "Upgrades",
  "LongGuns",
  "Melee",
  "Pistols",
  "WeaponSkins",
  "RawUpgrades",
  "Recipes",
  "Consumables",
];

const DE_CURRENCY_KEYS = [
  "RegularCredits",
  "PremiumCredits",
  "PremiumCreditsFree",
  "FusionPoints",
  "PrimeTokens",
];

export function unwrapPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    if (typeof current === "string") {
      try {
        current = JSON.parse(current);
        continue;
      } catch {
        return value;
      }
    }
    if (!current || typeof current !== "object") return current;
    const record = current as Record<string, unknown>;
    if (ITEM_ARRAY_KEYS.some((key) => Array.isArray(record[key]))) return current;
    const next = ENVELOPE_KEYS.map((key) => record[key]).find((v) => v !== undefined);
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function readItem(value: unknown, source: SourceRef): ItemStack | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawKey = record.ItemType ?? record.uniqueName ?? record.key ?? record.type;
  const displayName =
    typeof record.name === "string"
      ? record.name
      : typeof record.displayName === "string"
        ? record.displayName
        : null;
  const key = typeof rawKey === "string" && rawKey ? rawKey : displayName ? slug(displayName) : null;
  if (!key) return null;

  const item: ItemStack = {
    key,
    displayName,
    count: asNumber(record.ItemCount ?? record.count ?? record.quantity, 1),
    source,
  };
  const rank = record.XP ?? record.rank ?? record.ItemLevel;
  if (rank !== undefined) item.rank = asNumber(rank);
  const category = record.category ?? record.ProductCategory;
  if (typeof category === "string") item.category = category;
  return item;
}

function readProgression(value: unknown, source: SourceRef): ProgressionEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawKey = record.key ?? record.uniqueName ?? record.name;
  if (typeof rawKey !== "string" || !rawKey) return null;
  const entry: ProgressionEntry = {
    key: rawKey,
    displayName: typeof record.name === "string" ? record.name : null,
    kind: typeof record.kind === "string" ? record.kind : "unknown",
    source,
  };
  if (record.rank !== undefined) entry.rank = asNumber(record.rank);
  if (record.xp !== undefined) entry.xp = asNumber(record.xp);
  if (typeof record.completed === "boolean") entry.completed = record.completed;
  return entry;
}

export function snapshotFromExport(payload: unknown, observedAt: string): AccountSnapshot {
  const data = unwrapPayload(payload);
  const source: SourceRef = { providerId: PROVIDER_ID, fidelity: "full", observedAt };
  const snapshot = emptySnapshot();
  snapshot.schemaVersion = SNAPSHOT_SCHEMA_VERSION;
  snapshot.sources = [source];
  snapshot.raw = payload;

  if (!data || typeof data !== "object") return snapshot;
  const record = data as Record<string, unknown>;

  if (typeof record.DisplayName === "string") snapshot.account.displayName = record.DisplayName;
  else if (typeof record.displayName === "string") snapshot.account.displayName = record.displayName;
  const accountId = record.AccountId ?? record.accountId ?? record.playerId;
  snapshot.account.accountIdHash = hashAccountId(
    typeof accountId === "string" ? accountId : accountId == null ? null : String(accountId),
  );
  if (typeof record.BuildLabel === "string") snapshot.gameBuild = record.BuildLabel;

  for (const key of ITEM_ARRAY_KEYS) {
    const array = record[key];
    if (!Array.isArray(array)) continue;
    for (const raw of array) {
      const item = readItem(raw, source);
      if (item) snapshot.items.push(item);
    }
  }

  const currencies = record.currencies;
  if (currencies && typeof currencies === "object") {
    for (const [name, amount] of Object.entries(currencies as Record<string, unknown>)) {
      snapshot.currencies[name] = asNumber(amount);
    }
  }
  for (const key of DE_CURRENCY_KEYS) {
    if (record[key] !== undefined) snapshot.currencies[key] = asNumber(record[key]);
  }

  const progression = record.progression;
  if (Array.isArray(progression)) {
    for (const raw of progression) {
      const entry = readProgression(raw, source);
      if (entry) snapshot.progression.push(entry);
    }
  }

  return snapshot;
}
