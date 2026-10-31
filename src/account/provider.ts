import type { AccountSnapshot } from "./snapshot";

export type RiskTier =
  | "safe"
  | "caution"
  | "prohibited";

export interface ProviderMeta {
  id: string;
  label: string;
  risk: RiskTier;
  requiresCredentials: boolean;
  touchesGameProcess: boolean;
  description: string;
  consentPrompt?: string;
}

export interface CaptureContext {
  paths?: Record<string, string>;
  signal?: AbortSignal;
}

export interface Availability {
  available: boolean;
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

  needsConsent(): AccountDataProvider[] {
    return this.list().filter((p) => p.meta.risk === "caution");
  }
}
