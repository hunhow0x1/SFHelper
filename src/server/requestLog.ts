import { appendFile, readFile } from "node:fs/promises";
import { appFile } from "./paths";
import { writeFileAtomic } from "./files";

export type RequestKind = "inventory" | "profile" | "account";

export interface RequestEntry {
  at: string;
  kind: RequestKind;
  status: number | null;
  ms: number;
  bytes: number | null;
  empty?: boolean;
  attempt?: number;
  of?: number;
  server?: string;
  error?: string;
}

const KEEP_MS = 30 * 24 * 3600_000;
const NO_BODY = new Set([101, 204, 205, 304]);

const ledgerPath = () => appFile("requests.log");
const disabled = () => !!process.env.VITEST && !process.env.SFHELPER_HOME;

export async function recordRequest(entry: RequestEntry): Promise<void> {
  if (disabled()) return;
  try {
    await appendFile(ledgerPath(), `${JSON.stringify(entry)}\n`);
  } catch {
  }
}

export function tracked(kind: RequestKind, fetchImpl: typeof fetch = fetch, extra: { attempt?: number; of?: number } = {}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const started = Date.now();
    const base = { at: new Date(started).toISOString(), kind, ...extra };
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(input, init);
      text = NO_BODY.has(response.status) ? "" : await response.text();
    } catch (err) {
      await recordRequest({ ...base, status: null, ms: Date.now() - started, bytes: null, error: (err as Error).message });
      throw err;
    }
    const trimmed = text.trim();
    const server = response.headers.get("server");
    await recordRequest({
      ...base,
      status: response.status,
      ms: Date.now() - started,
      bytes: Buffer.byteLength(text),
      ...(response.ok && (trimmed === "" || trimmed === "{}") ? { empty: true } : {}),
      ...(server ? { server } : {}),
    });
    return new Response(NO_BODY.has(response.status) ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

export async function readRequests(since = 0, now = Date.now()): Promise<RequestEntry[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath(), "utf8");
  } catch {
    return [];
  }
  const out: RequestEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as RequestEntry;
      const t = Date.parse(e.at);
      if (t >= since && t <= now) out.push(e);
    } catch {
    }
  }
  return out;
}

export async function pruneRequests(now = Date.now()): Promise<void> {
  if (disabled()) return;
  const keep = await readRequests(now - KEEP_MS, now);
  try {
    await writeFileAtomic(ledgerPath(), keep.map((e) => JSON.stringify(e)).join("\n") + (keep.length ? "\n" : ""));
  } catch {
  }
}

export interface RequestSummary {
  total: number;
  byKind: Record<string, Record<string, number>>;
  lastOk: string | null;
  recent: RequestEntry[];
}

export interface KindActivity {
  last: string;
  status: number | null;
  empty: boolean;
  count: number;
}

export function activityByKind(entries: RequestEntry[]): Partial<Record<RequestKind, KindActivity>> {
  const out: Partial<Record<RequestKind, KindActivity>> = {};
  for (const e of [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    out[e.kind] = { last: e.at, status: e.status, empty: !!e.empty, count: (out[e.kind]?.count ?? 0) + 1 };
  }
  return out;
}

export function summarizeRequests(unsorted: RequestEntry[], recent = 10): RequestSummary {
  const entries = [...unsorted].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const byKind: Record<string, Record<string, number>> = {};
  let lastOk: string | null = null;
  for (const e of entries) {
    const status = e.status === null ? "error" : e.empty ? `${e.status} empty` : String(e.status);
    const k = (byKind[e.kind] ??= {});
    k[status] = (k[status] ?? 0) + 1;
    if (e.status !== null && e.status >= 200 && e.status < 300 && !e.empty) lastOk = e.at;
  }
  return { total: entries.length, byKind, lastOk, recent: entries.slice(-recent) };
}
