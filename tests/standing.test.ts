import { describe, expect, it } from "vitest";
import { dailyCaps, fullDailyCap } from "../src/server/standing";

const PATCH_DAY = Date.UTC(2026, 10, 5, 21);
const NEXT_DAY = Date.UTC(2026, 10, 6, 0, 0, 1);
const none = { affiliation: null, affiliationOde: null };

describe("the daily standing cap", () => {
  it("is 30,000 plus 1,000 per Envoy Rank from the first reset of Preludes 17", () => {
    expect(fullDailyCap(17, PATCH_DAY)).toBe(24_500);
    expect(fullDailyCap(17, NEXT_DAY)).toBe(47_000);
    expect(fullDailyCap(19, NEXT_DAY)).toBe(49_000);
    expect(dailyCaps(19, none, null, NEXT_DAY)).toMatchObject({ cap: 49_000, remaining: 49_000, odeCap: 49_000 });
    expect(dailyCaps(17, { affiliation: 40_000, affiliationOde: 47_000 }, null, NEXT_DAY)).toMatchObject({ cap: 47_000, remaining: 40_000, earned: 7_000 });
  });

  it("keeps the old cap on the day the patch arrived", () => {
    expect(dailyCaps(17, { affiliation: 22_890, affiliationOde: 23_885 }, null, PATCH_DAY)).toMatchObject({ cap: 24_500, remaining: 22_890, earned: 2_225 });
  });

  it("trusts a larger cap reported by the servers", () => {
    expect(dailyCaps(17, { affiliation: 49_000, affiliationOde: null }, null, NEXT_DAY)).toMatchObject({ cap: 49_000, remaining: 49_000 });
    expect(dailyCaps(null, none, null)).toBeNull();
  });
});
