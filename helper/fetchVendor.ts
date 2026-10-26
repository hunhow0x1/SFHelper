/** Ask DE's server for a vendor's current stock (getVendorInfo.php), with the
 *  login session the inventory import found - the same read-only request the
 *  game makes for Avakot's shop. One request per call; the caller decides how
 *  often (see src/server/avakot.ts). Stops hard on 403/429 like the import.
 */

import { EndpointRefusedError } from "./fetchInventory";

const ENDPOINT = "https://api.soulframe.com/api/getVendorInfo.php";
const USER_AGENT = "SFHelper-memory-helper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
/** A 24-hex Mongo ObjectId. */
const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/i;

/** The response body. Throws EndpointRefusedError on 403/429. */
export async function fetchVendorInfo(
  accountId: string,
  nonce: string,
  vendor: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!ACCOUNT_ID_RE.test(accountId)) throw new Error("account id must be 24 hex characters");
  const url = new URL(ENDPOINT);
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("vendor", vendor);
  const response = await fetchImpl(url.toString(), { headers: { "user-agent": USER_AGENT } });
  if (response.status === 403 || response.status === 429) throw new EndpointRefusedError(response.status);
  if (!response.ok) throw new Error(`vendor request failed (HTTP ${response.status})`);
  return response.text();
}
