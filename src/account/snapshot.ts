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
