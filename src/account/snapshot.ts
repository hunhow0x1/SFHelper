export const SNAPSHOT_SCHEMA_VERSION = 1;

export type Fidelity =
  | "full"
  | "partial"
  | "observed";

export interface SourceRef {
  providerId: string;
  fidelity: Fidelity;
  observedAt: string;
}

export interface AccountIdentity {
  displayName: string | null;
  accountIdHash: string | null;
}

export interface ItemStack {
  key: string;
  displayName: string | null;
  count: number;
  rank?: number;
  category?: string;
  source: SourceRef;
}

export interface ProgressionEntry {
  key: string;
  displayName: string | null;
  kind: string;
  rank?: number;
  xp?: number;
  completed?: boolean;
  source: SourceRef;
}

export interface AccountSnapshot {
  schemaVersion: number;
  capturedAt: string;
  gameBuild: string | null;
  account: AccountIdentity;
  items: ItemStack[];
  currencies: Record<string, number>;
  progression: ProgressionEntry[];
  sources: SourceRef[];
  raw?: unknown;
}

export function emptySnapshot(): AccountSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    gameBuild: null,
    account: { displayName: null, accountIdHash: null },
    items: [],
    currencies: {},
    progression: [],
    sources: [],
  };
}

const FIDELITY_RANK: Record<Fidelity, number> = { observed: 0, partial: 1, full: 2 };

export function preferred(a: SourceRef, b: SourceRef): SourceRef {
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt ? a : b;
  return FIDELITY_RANK[a.fidelity] >= FIDELITY_RANK[b.fidelity] ? a : b;
}

function mergeKeyed<T extends { key: string; source: SourceRef }>(base: T[], incoming: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const entry of base) byKey.set(entry.key, entry);
  for (const entry of incoming) {
    const existing = byKey.get(entry.key);
    if (!existing || preferred(existing.source, entry.source) === entry.source) {
      byKey.set(entry.key, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function mergeSnapshots(base: AccountSnapshot, incoming: AccountSnapshot): AccountSnapshot {
  const full = incoming.sources.some((s) => s.fidelity === "full");
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    gameBuild: incoming.gameBuild ?? base.gameBuild,
    account: {
      displayName: incoming.account.displayName ?? base.account.displayName,
      accountIdHash: incoming.account.accountIdHash ?? base.account.accountIdHash,
    },
    items: full ? incoming.items : mergeKeyed(base.items, incoming.items),
    currencies: { ...base.currencies, ...incoming.currencies },
    progression: full
      ? incoming.progression
      : mergeKeyed(base.progression, incoming.progression),
    sources: [...base.sources, ...incoming.sources].slice(-32),
  };
}
