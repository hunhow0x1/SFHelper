/** Acquisition providers and the safety rules the registry enforces.
 *
 *  Warframe's tooling scene learned this the hard way: the two techniques
 *  that produce the nicest data - logging in with the player's DE password,
 *  and scraping the session token out of the running game's memory - are
 *  also the two that put the account at risk. DE's EULA states the client
 *  may scan RAM for unauthorized third-party programs and act on what it
 *  finds, and a DE password is a single credential covering Warframe,
 *  Soulframe and store purchases with no OAuth and no scoping.
 *
 *  So the rule is structural rather than advisory: a provider that needs
 *  credentials or that touches the game process cannot be registered, and
 *  therefore cannot be reached from the UI. Relaxing the policy means
 *  editing this file in a reviewable commit, not flipping a setting.
 */

import type { AccountSnapshot } from "./snapshot";

export type RiskTier =
  /** Reads only what the user already has, or public unauthenticated data. */
  | "safe"
  /** Safe technique, but touches files whose format is undocumented and may
   *  break or misread between Preludes builds. Needs an informed opt-in. */
  | "caution"
  /** Never shipped. Present in the type so reviews have a word for it. */
  | "prohibited";

export interface ProviderMeta {
  id: string;
  label: string;
  risk: RiskTier;
  /** True if the provider ever asks for a Soulframe/DE account password,
   *  auth token, or session cookie. Registration refuses these. */
  requiresCredentials: boolean;
  /** True if the provider reads, writes or injects into the game process,
   *  or hooks its graphics/input. Registration refuses these. */
  touchesGameProcess: boolean;
  /** Shown in the source picker. */
  description: string;
  /** Shown before first use when risk is "caution". */
  consentPrompt?: string;
}

export interface CaptureContext {
  /** Absolute paths the user pointed us at (file import, log location). */
  paths?: Record<string, string>;
  signal?: AbortSignal;
}

export interface Availability {
  available: boolean;
  /** User-facing explanation when unavailable ("no EE.log found"). */
  reason?: string;
}

export interface AccountDataProvider {
  readonly meta: ProviderMeta;
  isAvailable(ctx: CaptureContext): Promise<Availability>;
  capture(ctx: CaptureContext): Promise<AccountSnapshot>;
}

export class UnsafeProviderError extends Error {
  constructor(id: string, reason: string) {
    super(`Provider "${id}" cannot be registered: ${reason}`);
    this.name = "UnsafeProviderError";
  }
}

export class ProviderRegistry {
  readonly #providers = new Map<string, AccountDataProvider>();

  register(provider: AccountDataProvider): void {
    const { id, requiresCredentials, touchesGameProcess, risk } = provider.meta;
    if (requiresCredentials) {
      throw new UnsafeProviderError(id, "it handles account credentials");
    }
    if (touchesGameProcess) {
      throw new UnsafeProviderError(id, "it reads or attaches to the game process");
    }
    if (risk === "prohibited") {
      throw new UnsafeProviderError(id, "it is marked prohibited");
    }
    if (this.#providers.has(id)) {
      throw new Error(`Provider "${id}" is already registered`);
    }
    this.#providers.set(id, provider);
  }

  get(id: string): AccountDataProvider | undefined {
    return this.#providers.get(id);
  }

  list(): AccountDataProvider[] {
    return [...this.#providers.values()];
  }

  /** Providers the user must acknowledge before first use. */
  needsConsent(): AccountDataProvider[] {
    return this.list().filter((p) => p.meta.risk === "caution");
  }
}
