/** Verify a candidate nonce against the live endpoint, then save the inventory.
 *
 *  The memory scan hands us a short list of candidate nonces; the server is the
 *  ground truth. We try each candidate against inventory.php - politely, one at
 *  a time, stopping hard on 403/429 - and the first that returns a real body is
 *  the nonce. Its response is written verbatim to inventory.json, which the main
 *  app ingests through its ordinary json-import provider. The risky code never
 *  runs in-process with the app.
 */

import { writeFile } from "node:fs/promises";

const ENDPOINT = "https://api.soulframe.com/api/inventory.php";
const USER_AGENT = "SFHelper-memory-helper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const MIN_INTERVAL_MS = 2000;
/** A 24-hex Mongo ObjectId. */
const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/i;

export class EndpointRefusedError extends Error {
  constructor(readonly status: number) {
    super(`Endpoint refused the request (${status}). Stopping - do not retry in a loop.`);
    this.name = "EndpointRefusedError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function buildUrl(accountId: string, nonce: string): string {
  const url = new URL(ENDPOINT);
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

export interface VerifyResult {
  nonce: string;
  body: string;
}

/** Try candidates until one returns a non-empty body. Returns null if none do
 *  (wrong candidates, or the game session is not actually live). */
export async function verifyNonce(
  accountId: string,
  candidates: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult | null> {
  if (!ACCOUNT_ID_RE.test(accountId)) throw new Error("account id must be 24 hex characters");

  for (let i = 0; i < candidates.length; i += 1) {
    if (i > 0) await sleep(MIN_INTERVAL_MS);
    const nonce = candidates[i];
    if (!nonce) continue;

    const response = await fetchImpl(buildUrl(accountId, nonce), {
      headers: { "user-agent": USER_AGENT },
    });
    if (response.status === 403 || response.status === 429) {
      throw new EndpointRefusedError(response.status);
    }
    if (!response.ok) continue;

    const body = await response.text();
    // An accepted request returns the inventory JSON; a rejected one is empty.
    if (body.trim() !== "" && body.trim() !== "{}") {
      return { nonce, body };
    }
  }
  return null;
}

/** Persist a verified inventory response for the app to import. */
export async function saveInventory(outPath: string, body: string): Promise<void> {
  // Store exactly what the server returned; the app's json-import unwraps it.
  await writeFile(outPath, body.endsWith("\n") ? body : `${body}\n`);
}
