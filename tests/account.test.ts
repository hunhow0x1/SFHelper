import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { snapshotFromExport, unwrapPayload } from "../src/account/providers/jsonImport";
import { snapshotFromProfile } from "../src/account/providers/profilePayload";

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

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/profile.sample.json", import.meta.url)), "utf8"),
) as unknown;

describe("profile payload parsing (real shape)", () => {
  const snap = snapshotFromProfile(fixture, "2026-08-23T00:00:00Z");

  it("reads identity and hashes the account id", () => {
    expect(snap.account.displayName).toBe("ExampleEnvoy");
    expect(snap.account.accountIdHash).toMatch(/^[0-9a-f]{32}$/);
    expect(snap.currencies.PlayerLevel).toBe(17);
  });

  it("folds equipped loadout and XPInfo into one item list", () => {
    const soul = snap.items.find((i) => i.category === "soul");
    expect(soul?.key).toContain("/SF/Souls/");
    expect(snap.items.every((i) => i.source.fidelity === "partial")).toBe(true);
    expect(snap.sources.some((s) => s.fidelity === "full")).toBe(false);
  });

  it("maps affiliations and challenges to progression", () => {
    const aff = snap.progression.find((p) => p.kind === "affiliation");
    expect(aff?.key).toMatch(/^affiliation:/);
    expect(typeof aff?.xp).toBe("number");
    expect(snap.progression.some((p) => p.kind === "challenge")).toBe(true);
  });

  it("surfaces per-weapon and per-enemy stats", () => {
    expect(snap.stats.weapons.length).toBeGreaterThan(0);
    expect(snap.stats.enemies.length).toBeGreaterThan(0);
    expect(typeof snap.stats.scalars.TimePlayedSec).toBe("number");
  });
});
