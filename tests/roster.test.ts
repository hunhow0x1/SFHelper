import { describe, expect, it } from "vitest";
import { notInGame, patchNumber } from "../scripts/build_data";

describe("weapons and Pacts that aren't in the game yet", () => {
  it("leaves out what the wiki files under a coming patch, or as upcoming or unobtainable", () => {
    expect(patchNumber("P16")).toBe(16);
    expect(patchNumber("2023.12.18")).toBeNull();
    expect(notInGame(["Short Blades", "Preludes_17", "Weapons"], 16)).toBe(true);
    expect(notInGame(["Short Blades", "Preludes 16", "Weapons"], 16)).toBe(false);
    expect(notInGame(["Preludes 3", "Preludes 17"], 16)).toBe(false);
    expect(notInGame(["Unobtainable", "Pacts"], 16)).toBe(true);
    expect(notInGame(["Upcoming"], null)).toBe(true);
    expect(notInGame(["Preludes 17"], null)).toBe(false);
  });
});
