import { describe, expect, it } from "vitest";
import { estimateEnvoyRank, itemMastery, observe } from "../src/server/envoyRank";
import { parseMaxMastery } from "../scripts/build_data";

const W = (n: number) => `/SF/Weapons/Melee/W${n}`;
const P = (n: number) => `/SF/Souls/P${n}/P${n}Soul`;
const XP30 = 450_000;

describe("Envoy Rank", () => {
  it("reads the patch maximum from the wiki's wording", () => {
    expect(parseMaxMastery("'''Maximum Mastery''' as of {{VerShort|P16}} is ~'''19.1''' for [[Paragon Founders]].")).toEqual({
      maxMastery: 19.1,
      patch: "P16",
    });
    expect(parseMaxMastery("no figure here")).toBeNull();
  });

  it("counts weapon and pact ranks from the mastery record, capped at 30", () => {
    expect(itemMastery({ [W(1)]: 2_000_000, [W(2)]: 500 * 10 * 10, [P(1)]: XP30, "/SF/Other/X": 9e9 })).toEqual({
      weaponRanks: 40,
      pactRanks: 30,
      units: 40 + 3.5 * 30,
    });
  });

  const base = { weaponCount: 10, pactCount: 2, maxMastery: 19.1, patch: "P16" };

  it("estimates progress inside the known rank, and none at the patch's top rank", () => {
    const all = Object.fromEntries([...Array.from({ length: 10 }, (_, i) => [W(i), XP30]), [P(0), XP30], [P(1), XP30]]);
    const half = Object.fromEntries([...Array.from({ length: 5 }, (_, i) => [W(i), XP30]), [P(0), XP30], [P(1), XP30]]);
    const r = estimateEnvoyRank({ ...base, rank: 17, mastery: half });
    expect(r.maxRank).toBe(19);
    expect(r.progress).toBeGreaterThanOrEqual(0);
    expect(r.progress).toBeLessThan(1);
    // Inconsistent data (more items than rank 17 should allow) is clamped, not overflowed.
    expect(estimateEnvoyRank({ ...base, rank: 17, mastery: all }).progress).toBe(0.99);
    expect(estimateEnvoyRank({ ...base, rank: 19, mastery: all }).progress).toBeNull();
  });

  it("anchors a rank at the item Mastery seen when it was reached", () => {
    let s = observe({ anchors: {} }, 17, 2200);
    expect(s.anchors).toEqual({}); // first sighting: no rank-up seen
    s = observe(s, 18, 2300);
    expect(s.anchors).toEqual({ "18": 2250 });
    const r = estimateEnvoyRank({ ...base, rank: 18, mastery: {}, anchor: 2250 });
    expect(r.calibrated).toBe(true);
    expect(r.progress).toBe(0); // no items: below the anchor, clamped to the start
  });
});
