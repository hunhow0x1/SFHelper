import { describe, expect, it } from "vitest";
import { parseMastery } from "../src/server/weapons";

describe("mastery record (XPInfo)", () => {
  it("keeps the most XP per item type and skips malformed entries", () => {
    expect(
      parseMastery({
        XPInfo: [
          { ItemType: "/SF/Weapons/A", XP: 511316 },
          { ItemType: "/SF/Weapons/A", XP: 145 },
          { ItemType: "/SF/Souls/B", XP: 450859 },
          { ItemType: "/SF/Weapons/C" },
          { XP: 9 },
        ],
      }),
    ).toEqual({ "/SF/Weapons/A": 511316, "/SF/Souls/B": 450859 });
  });

  it("is empty without a record", () => {
    expect(parseMastery({})).toEqual({});
    expect(parseMastery(null)).toEqual({});
  });
});
