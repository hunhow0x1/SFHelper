import type { AccountDataProvider, Availability, CaptureContext, ProviderMeta } from "../provider";
import { type AccountSnapshot } from "../snapshot";
import { snapshotFromProfile, type ProfileSnapshot } from "./profilePayload";

const PROVIDER_ID = "public-web";
const DEFAULT_ENDPOINT = "https://api.soulframe.com/cdn/getProfileViewingData.php?playerId={accountId}";
const ACCOUNT_ID_RE = /^[0-9a-f]{24}$/i;

export interface EndpointConfig {
  id: string;
  url: string;
  kind: string;
  expects: string;
}

export interface EndpointsFile {
  userAgent: string;
  minIntervalMs: number;
  confirmed: EndpointConfig[];
  candidates?: EndpointConfig[];
}

export class RateLimiter {
  #next = 0;
  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async wait(): Promise<void> {
    const now = this.now();
    const delay = Math.max(0, this.#next - now);
    this.#next = Math.max(now, this.#next) + this.minIntervalMs;
    if (delay > 0) await this.sleep(delay);
  }
}

export class EndpointRefusedError extends Error {
  constructor(readonly status: number, url: string) {
    super(`Endpoint refused the request (${status}): ${url}. Stopping - do not retry in a loop.`);
    this.name = "EndpointRefusedError";
  }
}

export function fillTemplate(url: string, vars: Record<string, string>): string {
  return url.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Endpoint template needs "${key}"`);
    return encodeURIComponent(value);
  });
}

export interface PublicWebDeps {
  endpoints: EndpointsFile;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
}

export function createPublicWebProvider(deps: PublicWebDeps): AccountDataProvider {
  const doFetch = deps.fetchImpl ?? fetch;
  const limiter = deps.limiter ?? new RateLimiter(deps.endpoints.minIntervalMs);
  const endpoint =
    deps.endpoints.confirmed.find((e) => e.kind === "account")?.url ?? DEFAULT_ENDPOINT;

  const meta: ProviderMeta = {
    id: PROVIDER_ID,
    label: "Public profile lookup",
    risk: "safe",
    requiresCredentials: false,
    touchesGameProcess: false,
    description:
      "Read a public profile by account id - equipped arsenal, mastery XP, lifetime and per-weapon/enemy stats, standing. No login, nothing the game does not already publish.",
  };

  return {
    meta,
    async isAvailable(ctx: CaptureContext): Promise<Availability> {
      const id = ctx.paths?.accountId;
      if (!id) return { available: false, reason: "no account id entered" };
      if (!ACCOUNT_ID_RE.test(id)) return { available: false, reason: "account id is not a 24-hex id" };
      return { available: true };
    },
    async capture(ctx: CaptureContext): Promise<AccountSnapshot> {
      const accountId = ctx.paths?.accountId;
      if (!accountId) throw new Error("public-web requires paths.accountId");
      if (!ACCOUNT_ID_RE.test(accountId)) throw new Error("account id must be 24 hex characters");

      await limiter.wait();
      const url = fillTemplate(endpoint, { accountId });
      const init: RequestInit = { headers: { "user-agent": deps.endpoints.userAgent } };
      if (ctx.signal) init.signal = ctx.signal;
      const response = await doFetch(url, init);

      if (response.status === 403 || response.status === 429) {
        throw new EndpointRefusedError(response.status, url);
      }
      if (!response.ok) throw new Error(`Profile lookup failed (${response.status})`);

      const text = await response.text();
      if (text.trim() === "") throw new Error(`No profile for account id ${accountId}`);
      return snapshotFromProfile(JSON.parse(text) as unknown, new Date().toISOString());
    },
  };
}

export type { ProfileSnapshot };
export { snapshotFromProfile } from "./profilePayload";
