import { writeFileAtomic } from "../src/server/files";
import { userAgent } from "../src/server/userAgent";
import { tracked } from "../src/server/requestLog";

const ENDPOINT = "https://api.soulframe.com/api/inventory.php";
const MIN_INTERVAL_MS = 2000;
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

    const response = await tracked("inventory", fetchImpl, { attempt: i + 1, of: candidates.length })(buildUrl(accountId, nonce), {
      headers: { "user-agent": userAgent() },
    });
    if (response.status === 403 || response.status === 429) {
      throw new EndpointRefusedError(response.status);
    }
    if (!response.ok) continue;

    const body = await response.text();
    if (body.trim() !== "" && body.trim() !== "{}") {
      return { nonce, body };
    }
  }
  return null;
}

export async function saveInventory(outPath: string, body: string): Promise<void> {
  await writeFileAtomic(outPath, body.endsWith("\n") ? body : `${body}\n`);
}
