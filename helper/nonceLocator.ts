import type { ReadOnlyMemory, ScanHit } from "./memoryReader";

export type NonceForm = "address" | "field" | "nearby";

export interface NonceCandidate {
  token: string;
  form: NonceForm;
  seen: number;
}

const VALUE = "-?\\d{6,24}|[0-9a-fA-F]{16,32}";
const END = "(?![0-9A-Za-z])";
const AT_START = new RegExp(`^(${VALUE})${END}`);
const AFTER_ID = new RegExp(`^&nonce=(${VALUE})${END}`);
const AFTER_KEY = new RegExp(`^"?\\s*[:=]\\s*"?(${VALUE})${END}`);
const ANYWHERE = new RegExp(`(?:^|[^0-9A-Za-z])(${VALUE})${END}`, "g");
const RANK: Record<NonceForm, number> = { address: 3, field: 2, nearby: 1 };
const MAX_HITS = 256;

export function rankNonceCandidates(afterId: ScanHit[], afterParam: ScanHit[], afterKey: ScanHit[], accountId: string): NonceCandidate[] {
  const found = new Map<string, NonceCandidate>();
  const note = (token: string, form: NonceForm): void => {
    if (token === accountId) return;
    const c = found.get(token);
    if (!c) found.set(token, { token, form, seen: 1 });
    else {
      c.seen += 1;
      if (RANK[form] > RANK[c.form]) c.form = form;
    }
  };
  const text = (hit: ScanHit) => hit.trailing.toString("latin1");

  for (const hit of afterParam) {
    const m = AT_START.exec(text(hit));
    if (m) note(m[1]!, "address");
  }
  for (const hit of afterId) {
    const t = text(hit);
    const m = AFTER_ID.exec(t);
    if (m) note(m[1]!, "address");
    else for (const n of t.matchAll(ANYWHERE)) note(n[1]!, "nearby");
  }
  for (const hit of afterKey) {
    const m = AFTER_KEY.exec(text(hit));
    if (m) note(m[1]!, "field");
  }
  return [...found.values()].sort((a, b) => RANK[b.form] - RANK[a.form] || b.seen - a.seen);
}

export async function findNonceCandidates(
  mem: ReadOnlyMemory,
  accountId: string,
  onProgress?: (scanned: number, total: number) => void,
): Promise<NonceCandidate[]> {
  const [afterId, afterParam, afterKey] = await mem.scanMany(
    [
      { needle: Buffer.from(accountId, "latin1"), trailingBytes: 96, maxHits: MAX_HITS },
      { needle: Buffer.from("&nonce=", "latin1"), trailingBytes: 40, maxHits: MAX_HITS },
      { needle: Buffer.from("nonce", "latin1"), trailingBytes: 48, maxHits: MAX_HITS },
    ],
    { onProgress },
  );
  return rankNonceCandidates(afterId ?? [], afterParam ?? [], afterKey ?? [], accountId);
}
