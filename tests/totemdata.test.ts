import { describe, expect, it } from "vitest";
import { mergeTotemData, mergeTotemTexts, type TotemData } from "../scripts/build_data";

describe("refreshing totem data from the wiki", () => {
  const known: Record<string, TotemData> = {
    "Noble Nestling": {
      animal: "Rat",
      enhances: "Pull Smite",
      description: "Beady dignity",
      effect: "Buff Virtue $1 % associated with enemy soul colour on Pull Smite",
      base: [["5", "8", "10", "12"]],
      grip: [["5", "10", "12", "15"]],
    },
    "Draft Dam": {
      animal: "Beaver",
      enhances: "Rune Activation",
      description: "Restraining current's flow",
      effect: "Reduce Rune drain by $1 %",
      base: [["10", "15", "20", "25"]],
      grip: [["15", "20", "25", "35"]],
    },
  };

  it("keeps known numbers where the wiki has gaps, and new ones where it has them", () => {
    const merged = mergeTotemData(
      {
        "Noble Nestling": {
          ...known["Noble Nestling"]!,
          effect: "Buff Virtue $1% associated with enemy soul colour for $2s on Pull Smite",
          base: [[null, null, null, "13"], ["5", "8", "10", "12"]],
          grip: [[null, null, null, null], ["5", "10", "12", "15"]],
        },
        "Draft Dam": { ...known["Draft Dam"]!, base: [["10", "15", "20", "30"]], grip: [["15", null, "25", "35"]] },
        "Far Foul": { animal: "Rabbit", enhances: "Pull Smite", description: "", effect: "Increase Pull Smite Range by +$1 m", base: [["2", "3", "4", "5"]], grip: [["3", "4", "6", "8"]] },
      },
      known,
    );
    expect(merged["Noble Nestling"]).toEqual(known["Noble Nestling"]);
    expect(merged["Draft Dam"]!.base).toEqual([["10", "15", "20", "30"]]);
    expect(merged["Draft Dam"]!.grip).toEqual([["15", "20", "25", "35"]]);
    expect(merged["Far Foul"]!.grip).toEqual([["3", "4", "6", "8"]]);
    expect(mergeTotemData({ "Far Foul": { ...merged["Far Foul"]!, base: [["2", null, "4", "5"]] } }, null)).toEqual({});
  });

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
