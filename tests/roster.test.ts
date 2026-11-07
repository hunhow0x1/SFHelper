import { describe, expect, it } from "vitest";
import { notInGame, patchNumber } from "../scripts/build_data";
import { buildRoster } from "../src/server/roster";

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

describe("the Mastery roster", () => {
  const game = (name: string, slot: string, style: string | null, damage: string | null = "SLASH") => ({ name, slot, style, damage });
  const arsenal = {
    weapons: {
      a: game("Rostrum", "Primary", "MS_DAGGER"),
      b: game("Loksprik", "Primary", "MS_DAGGER"),
      c: game("Wreath", "Primary", "MS_HEAVY_SWORD", "IMPACT"),
      d: game("Orst-III", "Primary", "MS_HEAVY_SWORD", "IMPACT"),
      e: game("Creance", "Primary", "MS_HEAVY_SWORD", "IMPACT"),
      f: game("Goody's Edge", "Sidearm", "MS_AKIMBO_SHORT_SWORD"),
      g: game("Odd One", "Primary", "MS_NEW_STYLE"),
    },
    pacts: { p: "Ode Tempest", q: "Ode Shrike" },
  };
  const wiki = {
    Rostrum: { class: "Daggers", slot: "Primary" },
    Wreath: { class: "Other", slot: "Primary" },
    "Orst-III": { class: "Heavy Maces", slot: "Primary" },
    "Goody's Edge": { class: "Short Blades", slot: "Primary" },
    "Not In Game": { class: "Bows", slot: "Primary" },
  };

  it("lists what the game files have, with the wiki's class or one guessed from similar weapons", () => {
    const roster = buildRoster(wiki, arsenal);
    expect(roster.weapons).toEqual({
      Creance: { class: "Heavy Maces", slot: "Primary" },
      "Goody's Edge": { class: "Short Blades", slot: "Sidearm" },
      Loksprik: { class: "Daggers", slot: "Primary" },
      "Odd One": { class: "Other", slot: "Primary" },
      "Orst-III": { class: "Heavy Maces", slot: "Primary" },
      Rostrum: { class: "Daggers", slot: "Primary" },
      Wreath: { class: "Heavy Maces", slot: "Primary" },
    });
    expect(Object.keys(roster.pacts)).toEqual(["Ode Shrike", "Ode Tempest"]);
  });

  it("falls back to the wiki's weapons without game files", () => {
    expect(buildRoster(wiki, null)).toEqual({ weapons: wiki, pacts: {} });
  });
});
