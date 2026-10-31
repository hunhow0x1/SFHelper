import type { ReadOnlyMemory } from "./memoryReader";
import { EndpointRefusedError } from "./fetchInventory";

const OID_RE = /[0-9a-f]{24}/gi;
const PROFILE_ENDPOINT = "https://api.soulframe.com/cdn/getProfileViewingData.php?playerId=";
const USER_AGENT = "SFHelper-memory-helper/0.0 (+https://github.com/hunhow0x1/SFHelper)";

function oidsFrom(buf: Buffer): string[] {
  return [...buf.toString("latin1").matchAll(OID_RE)].map((m) => m[0].toLowerCase());
}

export async function findAccountIdCandidates(
  mem: ReadOnlyMemory,
  onProgress?: (scanned: number, total: number) => void,
): Promise<string[]> {
  const ranked = new Map<string, number>();
  const consider = (id: string, weight: number): void => {
    if (weight > (ranked.get(id) ?? 0)) ranked.set(id, weight);
  };

  const [afterParam, afterOid] = await mem.scanMany(
    [
      { needle: Buffer.from("accountId=", "latin1"), trailingBytes: 26 },
      { needle: Buffer.from("$oid", "latin1"), trailingBytes: 40 },
    ],
    { onProgress },
  );
  for (const hit of afterParam ?? []) {
    const [first] = oidsFrom(hit.trailing);
    if (first) consider(first, 3);
  }
  for (const hit of afterOid ?? []) {
    for (const id of oidsFrom(hit.trailing)) consider(id, 1);
  }

  return [...ranked.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export async function verifyAccountId(
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accountId: string; displayName: string | null } | null> {
  const response = await fetchImpl(PROFILE_ENDPOINT + encodeURIComponent(accountId), {
    headers: { "user-agent": USER_AGENT },
  });
  if (response.status === 403 || response.status === 429) throw new EndpointRefusedError(response.status);
  if (!response.ok) return null;
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    const parsed = JSON.parse(text) as { Results?: Array<{ DisplayName?: string }> };
    const result = parsed.Results?.[0];
    if (!result) return null;
    return { accountId, displayName: result.DisplayName ?? null };
  } catch {
    return null;
  }
}

export async function discoverVerifiedAccountId(
  candidates: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ accountId: string; displayName: string | null } | null> {
  for (let i = 0; i < candidates.length; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    const candidate = candidates[i];
    if (!candidate) continue;
    const verified = await verifyAccountId(candidate, fetchImpl);
    if (verified) return verified;
  }
  return null;
}
