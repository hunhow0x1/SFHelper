/** The one shape the rest of the app reads.
 *
 *  Every acquisition method - a hand-typed item, a parsed log line, a JSON
 *  export - lands here first, so no feature ever depends on where the data
 *  came from. Soulframe is still in Preludes and its account data changes
 *  shape between builds, so the schema is versioned and deliberately loose
 *  about item taxonomy: unknown fields survive in `raw`.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** How complete a snapshot claims to be. Only a full account export is
 *  authoritative; everything a safe source can produce is partial, and the
 *  merge rules below exist because of that. */
export type Fidelity =
  /** Whole-account dump - anything absent is genuinely not owned. */
  | "full"
  /** A complete view of one slice (e.g. a single screen the user imported). */
  | "partial"
  /** Incidental sightings (log lines, OCR) - absence proves nothing. */
  | "observed";

export interface SourceRef {
  /** Provider id, e.g. "json-import", "ee-log". */
  providerId: string;
  fidelity: Fidelity;
  /** ISO-8601. When the underlying data was true, not when we parsed it. */
  observedAt: string;
}

export interface AccountIdentity {
  /** In-game name as the user typed or as it appeared in a log. */
  displayName: string | null;
  /** SHA-256 of any account id we happen to see, never the id itself, so a
   *  crash dump or a shared snapshot cannot deanonymize the player. */
  accountIdHash: string | null;
}

export interface ItemStack {
  /** Stable key. A DE-style internal path when we know one
   *  ("/Lotus/Types/..."), otherwise a slugged display name. */
  key: string;
  displayName: string | null;
  count: number;
  /** Rank/upgrade level where the item has one. */
  rank?: number;
  /** Free-form bucket ("weapon", "pact", "resource", ...). Soulframe's
   *  taxonomy is not settled; the UI groups on this, nothing else does. */
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
  /** When this snapshot object was assembled. */
  capturedAt: string;
  /** Game build string if a source told us one (log header, endpoint field). */
  gameBuild: string | null;
  account: AccountIdentity;
  items: ItemStack[];
  currencies: Record<string, number>;
  progression: ProgressionEntry[];
  /** Provenance of the snapshot as a whole; per-entry refs win over this. */
  sources: SourceRef[];
  /** Provider-native payload, kept so a later parser version can re-derive
   *  fields we did not understand yet. Never uploaded anywhere. */
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

/** Newer wins; on a tie the more authoritative source wins. */
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

/** Fold a new capture into what we already know.
 *
 *  A "full" capture is the only thing allowed to delete: if the account dump
 *  does not list an item, the player no longer owns it. A partial or observed
 *  capture can only add or update, because it never saw the whole account.
 */
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
