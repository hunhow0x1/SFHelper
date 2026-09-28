/** Recover the player's own account id from the running game's memory.
 *
 *  The game does not write the account id to disk (EE.cfg holds only the login
 *  email), so with Little Genius ruled out as a dependency, memory is the only
 *  automatic source. This reuses the same read-only reader as the nonce path.
 *
 *  The account id is a public identifier - it resolves through the public
 *  profile endpoint and appears in other players' squad data - not a secret.
 *  That also means candidates SELF-VERIFY: the real id is whichever one the
 *  public profile endpoint returns data for, so the scan only has to surface it
 *  among a short list, and no game session is required to confirm it.
 *
 *  Anchor: the client assembles "accountId=<24-hex>&nonce=..." when it calls
 *  inventory.php, so the id sits right after "accountId=". We also accept any
 *  bare 24-hex token near that anchor as a fallback.
 */

import type { ReadOnlyMemory } from "./memoryReader";

const OID_RE = /[0-9a-f]{24}/gi;
const PROFILE_ENDPOINT = "https://api.soulframe.com/cdn/getProfileViewingData.php?playerId=";
const USER_AGENT = "SFHelper-memory-helper/0.0 (+https://github.com/hunhow0x1/SFHelper)";

function oidsFrom(buf: Buffer): string[] {
  return [...buf.toString("latin1").matchAll(OID_RE)].map((m) => m[0].toLowerCase());
}

/** Collect candidate account ids from the neighborhood of the request anchor,
 *  most-promising first (immediately after "accountId=" ranks highest). */
export async function findAccountIdCandidates(
  mem: ReadOnlyMemory,
  onProgress?: (scanned: number, total: number) => void,
): Promise<string[]> {
  const ranked = new Map<string, number>();
  const consider = (id: string, weight: number): void => {
    if (weight > (ranked.get(id) ?? 0)) ranked.set(id, weight);
  };

  // Strongest: the id the client itself put into the inventory request URL.
  for (const hit of await mem.scan(Buffer.from("accountId=", "latin1"), { trailingBytes: 26, onProgress })) {
    const [first] = oidsFrom(hit.trailing);
    if (first) consider(first, 3);
  }
  // Fallback: ids near the "$oid" JSON key the profile/session data uses.
  for (const hit of await mem.scan(Buffer.from("$oid", "latin1"), { trailingBytes: 40, onProgress })) {
    for (const id of oidsFrom(hit.trailing)) consider(id, 1);
  }

  return [...ranked.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Confirm a candidate against the PUBLIC profile endpoint (no nonce, no
 *  session). Returns the display name on success so the caller can show it. */
export async function verifyAccountId(
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accountId: string; displayName: string | null } | null> {
  const response = await fetchImpl(PROFILE_ENDPOINT + encodeURIComponent(accountId), {
    headers: { "user-agent": USER_AGENT },
  });
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

/** First candidate the public endpoint accepts, or null. Polite: one at a time. */
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
