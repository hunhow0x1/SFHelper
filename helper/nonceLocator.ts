/** Locate the session nonce in the game's memory.
 *
 *  We do NOT rely on a hard-coded byte offset - that would break on every
 *  build and is exactly the fragile reverse-engineering this design avoids.
 *  Instead we gather CANDIDATES from the neighborhood of things we know are in
 *  memory, then let the live API confirm which one is real (see verifyNonce in
 *  fetchInventory.ts). The nonce is whatever value makes inventory.php return
 *  data; the memory scan only has to surface it among a short list.
 *
 *  Anchors we search around:
 *   - the account id (a 24-hex ObjectId the user supplies) - session state
 *     tends to store accountId and nonce close together;
 *   - the ASCII "nonce" key and the request fragment "&nonce=" that the client
 *     builds when it calls inventory.php.
 *
 *  This is heuristic by design. If the anchors stop yielding the real nonce
 *  after a game update, widen the anchors here - not the reader.
 */

import type { ReadOnlyMemory, ScanHit } from "./memoryReader";

/** Nonce tokens seen in DE traffic are runs of digits (sometimes signed) or
 *  hex; keep both, bounded to plausible lengths. */
const TOKEN_RE = /-?\b[0-9]{6,24}\b|\b[0-9a-fA-F]{16,32}\b/g;

function tokensFrom(buf: Buffer): string[] {
  const text = buf.toString("latin1");
  return [...text.matchAll(TOKEN_RE)].map((m) => m[0]);
}

/** Collect candidate nonces near every anchor. Returned most-promising first:
 *  values adjacent to the account id rank above values near the generic key. */
export async function findNonceCandidates(
  mem: ReadOnlyMemory,
  accountId: string,
  onProgress?: (scanned: number, total: number) => void,
): Promise<string[]> {
  const ranked = new Map<string, number>();
  const consider = (token: string, weight: number): void => {
    const prev = ranked.get(token) ?? 0;
    if (weight > prev) ranked.set(token, weight);
  };

  const harvest = (hits: ScanHit[], weight: number): void => {
    for (const hit of hits) {
      for (const token of tokensFrom(hit.trailing)) consider(token, weight);
    }
  };

  // Strongest anchor: bytes sitting right after the account id.
  harvest(await mem.scan(Buffer.from(accountId, "latin1"), { trailingBytes: 96, onProgress }), 3);
  // The request fragment the client assembles: "&nonce=" is followed by it.
  harvest(await mem.scan(Buffer.from("&nonce=", "latin1"), { trailingBytes: 40, onProgress }), 3);
  // Weaker: the bare key, which may precede the value in a struct/JSON.
  harvest(await mem.scan(Buffer.from("nonce", "latin1"), { trailingBytes: 48, onProgress }), 1);

  // Drop the account id itself if it slipped in as a token.
  ranked.delete(accountId);
  return [...ranked.entries()].sort((a, b) => b[1] - a[1]).map(([token]) => token);
}
