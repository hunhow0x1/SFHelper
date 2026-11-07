import { describe, expect, it } from "vitest";
import { mergeTotemTexts } from "../scripts/build_data";

describe("refreshing totem data from the wiki", () => {
  it("keeps a known sentence over one with unknown values", () => {
    expect(
      mergeTotemTexts(
        { "Noble Nestling": "Buff Virtue ?/?/?/13% associated with enemy soul colour for 5/8/10/12 s on Pull Smite", "Far Foul": "Increase Pull Smite Range by +2/3/4/5 m" },
        { "Noble Nestling": "Buff Virtue 5/8/10/12% associated with enemy soul colour on Pull Smite", "Turn Tusk": "Temporarily turn enemies into allies for 2/3/3/4 seconds on Pull Smite" },
      ),
    ).toEqual({
      "Noble Nestling": "Buff Virtue 5/8/10/12% associated with enemy soul colour on Pull Smite",
      "Far Foul": "Increase Pull Smite Range by +2/3/4/5 m",
      "Turn Tusk": "Temporarily turn enemies into allies for 2/3/3/4 seconds on Pull Smite",
    });
  });
});
