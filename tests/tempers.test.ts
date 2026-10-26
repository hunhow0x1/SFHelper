import { describe, expect, it } from "vitest";
import { withGameValues } from "../scripts/build_data";

describe("temper effects", () => {
  it("fills in values the wiki is missing from the game's data", () => {
    expect(withGameValues("LegShotMod", "Severed Root increases leg shot stagger by X When Double-Stacked, this bonus will be doubled to 2X."))
      .toMatch(/by 20%\..*doubled to 40%/);
    expect(withGameValues("MendicantFearMod", "Unnerving Blow provides a X% chance on hit to inflict the Fear status."))
      .toContain("10% chance");
    expect(withGameValues("DodgeAttackDamageMod", "Rejoinder ... and additional unknown stagger damage."))
      .toContain("12 more Stagger");
    expect(withGameValues("LegShotMod", null)).toContain("20%");
  });

  it("keeps the wiki's text once it has the numbers, and leaves other tempers alone", () => {
    const wiki = "Invader increases the Damage dealt to Foes with less than 30% Life by a +20 damage.";
    expect(withGameValues("CassidDamageOnNearDeathMod", wiki)).toBe(wiki);
    expect(withGameValues("AerialAttackDamageAMod", "From Above ... an additional X Damage.")).toBe("From Above ... an additional X Damage.");
    expect(withGameValues("SwiftStrikeMod", null)).toBeNull();
  });
});
