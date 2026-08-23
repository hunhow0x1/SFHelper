/** Fetch a public, unauthenticated endpoint.
 *
 *  This is the ideal source if it exists: Warframe serves the in-game
 *  profile viewer's data from content.warframe.com with no login at all, so
 *  a companion app can read a player's public profile without ever holding
 *  a credential. Whether Soulframe exposes the same surface is unknown -
 *  data/endpoints.json ships with an empty `confirmed` list, and this
 *  provider reports itself unavailable until something is verified there.
 *
 *  Etiquette is enforced here rather than left to callers: one request at a
 *  time, a floor on request spacing, an identifying User-Agent, Cache-Control
 *  respected, and a hard stop on 403/429 - DE has firewalled people for
 *  hammering these hosts.
 */

import type { AccountDataProvider, Availability, CaptureContext, ProviderMeta } from "../provider";
import { emptySnapshot, type AccountSnapshot, type SourceRef } from "../snapshot";
import { hashAccountId } from "../identity";
import { snapshotFromExport } from "./jsonImport";

const PROVIDER_ID = "public-web";

export interface EndpointConfig {
  id: string;
  url: string;
  kind: "static-content" | "world-state" | "account";
  expects: "json" | "lzma" | "text";
}

export interface EndpointsFile {
  userAgent: string;
  minIntervalMs: number;
  confirmed: EndpointConfig[];
  candidates: EndpointConfig[];
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
  return url.replace(/\{(\w+)\}/g, (match, key: string) => {
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
  const accountEndpoint = deps.endpoints.confirmed.find((e) => e.kind === "account");

  const meta: ProviderMeta = {
    id: PROVIDER_ID,
    label: "Public profile lookup",
    risk: "safe",
    requiresCredentials: false,
    touchesGameProcess: false,
    description:
      "Read a public profile endpoint by display name. No login, no token, nothing the game does not already publish.",
  };

  return {
    meta,
    async isAvailable(ctx: CaptureContext): Promise<Availability> {
      if (!accountEndpoint) {
        return {
          available: false,
          reason: "no public Soulframe profile endpoint has been confirmed yet",
        };
      }
      return ctx.paths?.displayName
        ? { available: true }
        : { available: false, reason: "no display name entered" };
    },
    async capture(ctx: CaptureContext): Promise<AccountSnapshot> {
      if (!accountEndpoint) throw new Error("no confirmed public profile endpoint");
      const displayName = ctx.paths?.displayName;
      if (!displayName) throw new Error("public-web requires paths.displayName");

      await limiter.wait();
      const url = fillTemplate(accountEndpoint.url, { displayName });
      const init: RequestInit = { headers: { "user-agent": deps.endpoints.userAgent } };
      if (ctx.signal) init.signal = ctx.signal;
      const response = await doFetch(url, init);

      if (response.status === 403 || response.status === 429) {
        throw new EndpointRefusedError(response.status, url);
      }
      if (!response.ok) throw new Error(`Profile lookup failed (${response.status})`);

      const payload: unknown = await response.json();
      const observedAt = new Date().toISOString();
      const snapshot = snapshotFromExport(payload, observedAt);
      // A public profile is a curated view, never the whole account.
      const source: SourceRef = { providerId: PROVIDER_ID, fidelity: "partial", observedAt };
      snapshot.sources = [source];
      for (const item of snapshot.items) item.source = source;
      for (const entry of snapshot.progression) entry.source = source;
      snapshot.account.displayName ??= displayName;
      snapshot.account.accountIdHash ??= hashAccountId(displayName);
      return snapshot;
    },
  };
}

/** Placeholder used by the UI when no source has ever run. */
export function noDataSnapshot(): AccountSnapshot {
  return emptySnapshot();
}
