import { describe, expect, it } from "vitest";
import { mergeSnapshots, emptySnapshot, type AccountSnapshot, type SourceRef } from "../src/account/snapshot";
import { ProviderRegistry, UnsafeProviderError, type AccountDataProvider } from "../src/account/provider";
import { snapshotFromExport, unwrapPayload } from "../src/account/providers/jsonImport";
import { parseLog, type LogRules } from "../src/account/providers/eeLog";
import { RateLimiter, fillTemplate } from "../src/account/providers/publicWeb";

function snapshotWith(source: SourceRef, keys: string[]): AccountSnapshot {
  const snapshot = emptySnapshot();
  snapshot.sources = [source];
  snapshot.items = keys.map((key) => ({ key, displayName: key, count: 1, source }));
  return snapshot;
}

const observed: SourceRef = { providerId: "ee-log", fidelity: "observed", observedAt: "2026-01-01T00:00:00Z" };
const full: SourceRef = { providerId: "json-import", fidelity: "full", observedAt: "2026-01-02T00:00:00Z" };

describe("snapshot merge", () => {
  it("lets a full capture drop items the account no longer has", () => {
    const merged = mergeSnapshots(snapshotWith(observed, ["a", "b"]), snapshotWith(full, ["b"]));
    expect(merged.items.map((i) => i.key)).toEqual(["b"]);
  });

  it("never lets an observed capture drop known items", () => {
    const merged = mergeSnapshots(snapshotWith(full, ["a", "b"]), snapshotWith(observed, ["c"]));
    expect(merged.items.map((i) => i.key)).toEqual(["a", "b", "c"]);
  });

  it("keeps the newer entry when both sources saw an item", () => {
    const merged = mergeSnapshots(snapshotWith(observed, ["a"]), snapshotWith(full, ["a"]));
    expect(merged.items[0]?.source.providerId).toBe("json-import");
  });
});

describe("provider registry", () => {
  function stub(meta: Partial<AccountDataProvider["meta"]>): AccountDataProvider {
    return {
      meta: {
        id: "stub",
        label: "Stub",
        risk: "safe",
        requiresCredentials: false,
        touchesGameProcess: false,
        description: "",
        ...meta,
      },
      isAvailable: async () => ({ available: true }),
      capture: async () => emptySnapshot(),
    };
  }

  it("refuses a provider that wants account credentials", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.register(stub({ requiresCredentials: true }))).toThrow(UnsafeProviderError);
  });

  it("refuses a provider that reads the game process", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.register(stub({ touchesGameProcess: true }))).toThrow(UnsafeProviderError);
  });

  it("accepts a safe provider", () => {
    const registry = new ProviderRegistry();
    registry.register(stub({}));
    expect(registry.list()).toHaveLength(1);
  });
});

describe("json import", () => {
  it("peels nested envelopes to reach the item arrays", () => {
    const nested = { data: JSON.stringify({ payload: { items: [{ name: "Ash", count: 2 }] } }) };
    expect(unwrapPayload(nested)).toEqual({ items: [{ name: "Ash", count: 2 }] });
  });

  it("normalizes items and hashes the account id", () => {
    const snapshot = snapshotFromExport(
      { displayName: "Envoy", accountId: "abc123", items: [{ name: "Bramble", count: 3 }] },
      "2026-01-01T00:00:00Z",
    );
    expect(snapshot.account.displayName).toBe("Envoy");
    expect(snapshot.account.accountIdHash).not.toBe("abc123");
    expect(snapshot.account.accountIdHash).toMatch(/^[0-9a-f]{32}$/);
    expect(snapshot.items[0]).toMatchObject({ key: "bramble", count: 3 });
  });
});

describe("ee.log parsing", () => {
  const rules: LogRules = {
    line: "^\\s*[\\d.]+\\s+(?<category>\\w+)\\s+\\[(?<level>\\w+)\\]:\\s*(?<message>.*)$",
    rules: [
      { id: "build-label", kind: "build", confidence: "likely", pattern: "^Build Label:\\s*(?<build>.+)$" },
      { id: "item", kind: "item", confidence: "unverified", pattern: "^Acquired\\s+(?<count>\\d+)\\s+(?<name>.+)$" },
    ],
  };

  it("reads the build label and skips unverified rules by default", () => {
    const log = ["  0.001 Sys [Info]: Build Label: 2026.08.01.12.00", "  1.500 Game [Info]: Acquired 4 Nightfold Ash"].join("\n");
    const snapshot = parseLog(log, rules, { observedAt: "2026-01-01T00:00:00Z" });
    expect(snapshot.gameBuild).toBe("2026.08.01.12.00");
    expect(snapshot.items).toHaveLength(0);
  });

  it("applies unverified rules when the caller opts in", () => {
    const log = "  1.500 Game [Info]: Acquired 4 Nightfold Ash";
    const snapshot = parseLog(log, rules, { minConfidence: "unverified", observedAt: "2026-01-01T00:00:00Z" });
    expect(snapshot.items[0]).toMatchObject({ key: "nightfold-ash", count: 4 });
    expect(snapshot.items[0]?.source.fidelity).toBe("observed");
  });
});

describe("public web etiquette", () => {
  it("spaces requests by the configured interval", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter(2000, () => now, async (ms) => {
      slept.push(ms);
      now += ms;
    });
    await limiter.wait();
    await limiter.wait();
    expect(slept).toEqual([2000]);
  });

  it("refuses to build a URL with an unfilled placeholder", () => {
    expect(() => fillTemplate("https://x/?n={displayName}", {})).toThrow(/displayName/);
    expect(fillTemplate("https://x/?n={displayName}", { displayName: "A B" })).toBe("https://x/?n=A%20B");
  });
});
