import { describe, expect, it } from "vitest";
import { buildRoster } from "../src/server/roster";

describe("the Mastery roster", () => {
  const game = (name: string, slot: string, grip: string | null) => ({ name, slot, style: null, damage: null, grip });
  const arsenal = {
    weapons: {
      a: game("Loksprik", "Primary", "Short Blade"),
      b: game("Marrow's Bane", "Primary", "Long Blade"),
      c: game("Orst-III", "Primary", "Heavy"),
      d: game("Goody's Edge", "Sidearm", "Short Blade"),
      e: game("Odd One", "Primary", null),
    },
    pacts: { p: "Ode Tempest", q: "Ode Shrike" },
  };

  it("lists the game's weapons, classed by the grip the game gives them", () => {
    const roster = buildRoster(arsenal);
    expect(roster.weapons).toEqual({
      "Goody's Edge": { class: "Short Blade", slot: "Sidearm" },
      Loksprik: { class: "Short Blade", slot: "Primary" },
      "Marrow's Bane": { class: "Long Blade", slot: "Primary" },
      "Odd One": { class: "Other", slot: "Primary" },
      "Orst-III": { class: "Heavy", slot: "Primary" },
    });
    expect(Object.keys(roster.pacts)).toEqual(["Ode Shrike", "Ode Tempest"]);
  });

  it("is empty without game data", () => {
    expect(buildRoster(null)).toEqual({ weapons: {}, pacts: {} });
  });
});
