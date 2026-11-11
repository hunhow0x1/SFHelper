import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { craftTimers, parseCrafting, parsePendingCrafts } from "../src/server/recipes";
import { TimerAlarms } from "../src/server/timers";
import { buildCraftingText, buildOtherCrafts, type CraftDef, type RecipeDef } from "../src/gamedata/builders";
import { getSettings, updateSettings } from "../src/server/settings";

const at = (ms: number) => ({ $date: { $numberLong: String(ms) } });
const DONE = Date.parse("2026-11-11T13:47:27Z");
const LATER = Date.parse("2026-11-11T16:16:22Z");

describe("crafts in progress", () => {
  it("reads what's curing and when it's ready, soonest first", () => {
    const pending = parsePendingCrafts([
      { ItemType: "/SF/Types/Recipes/Ingots/InfusedIngotT4Blueprint", CompletionDate: at(LATER), ItemId: { $oid: "b" } },
      { ItemType: "/SF/Types/Recipes/Weapons/SecondaryFeyDaggerMeleeWeaponBlueprint", CompletionDate: at(DONE), ItemId: { $oid: "a" } },
      { ItemType: "/SF/Types/Recipes/Weapons/NoDate" },
      { CompletionDate: at(DONE) },
    ]);
    expect(pending).toEqual([
      { id: "a", recipe: "/SF/Types/Recipes/Weapons/SecondaryFeyDaggerMeleeWeaponBlueprint", completes: DONE },
      { id: "b", recipe: "/SF/Types/Recipes/Ingots/InfusedIngotT4Blueprint", completes: LATER },
    ]);
    expect(parsePendingCrafts(undefined)).toEqual([]);
    expect(parseCrafting({ PendingRecipes: [{ ItemType: "/R/A", CompletionDate: at(DONE) }] }).pending).toEqual([{ id: null, recipe: "/R/A", completes: DONE }]);
  });

  it("names each craft for its Ready To Claim notification", () => {
    const defs: Record<string, CraftDef> = {
      "/R/Dagger": { name: "Witan", kind: "Weapons", slot: "Sidearm", result: "/W/Dagger", seconds: 72000, icon: null },
      "/R/Ingot": { name: "Rhapsodic Chordstone", kind: "Chordstones", result: "/I/Ingot", seconds: 32400, icon: null },
      "/R/Pact": { name: "Bromius", kind: "Pacts", result: "/S/Bromius", seconds: 97200, icon: null },
      "/R/Charm": { name: "Cardinal Charm", kind: "Talismans", result: "/T/Charm", seconds: 86400, icon: null },
      "/R/Bird": { name: "Lord Cardinal", kind: null, result: "/B/Bird", seconds: 36000, icon: null },
    };
    const timers = craftTimers(
      [
        { id: "a", recipe: "/R/Dagger", completes: DONE },
        { id: "b", recipe: "/R/Ingot", completes: LATER },
        { id: null, recipe: "/R/Pact", completes: LATER },
        { id: "c", recipe: "/R/Charm", completes: LATER },
        { id: "d", recipe: "/R/Bird", completes: LATER },
        { id: "e", recipe: "/R/Unknown", completes: LATER },
      ],
      defs,
    );
    expect(timers.map((t) => [t.tag, t.name, t.kind, t.ready])).toEqual([
      ["Craft-a", "Witan", "Sidearm", "Witan is ready to claim"],
      ["Craft-b", "Rhapsodic Chordstone", "Chordstone", "Rhapsodic Chordstone is ready to claim"],
      [`Craft-/R/Pact@${LATER}`, "Bromius", "Pact", "Bromius is ready to claim"],
      ["Craft-c", "Cardinal Charm", "Talisman", "Cardinal Charm is ready to claim"],
      ["Craft-d", "Lord Cardinal", null, "Lord Cardinal is ready to claim"],
    ]);
  });

  it("notifies when a craft finishes while SFHelper runs, not for one that was already done", () => {
    const defs: Record<string, CraftDef> = { "/R/A": { name: "Witan", kind: "Weapons", slot: "Sidearm", result: "/W/A", seconds: 60, icon: null } };
    const alarms = new TimerAlarms();
    alarms.set(craftTimers([{ id: "old", recipe: "/R/A", completes: DONE - 1 }, { id: "new", recipe: "/R/A", completes: DONE + 60_000 }], defs), DONE);
    expect(alarms.due(DONE + 30_000)).toEqual([]);
    expect(alarms.due(DONE + 60_000).map((t) => t.tag)).toEqual(["Craft-new"]);
    expect(alarms.due(DONE + 120_000)).toEqual([]);
  });
});

describe("Forge words and crafts from the game files", () => {
  it("takes the Forge's labels from the game's own text", () => {
    expect(
      buildCraftingText({
        "/SF/Language/Crafting/Foundry_ReadyToClaimHeader": "Ready To Claim",
        "/SF/Language/Crafting/Foundry_InProgressHeader": "In Progress",
        "/SF/Language/Crafting/NothingToClaim": "Nothing to Claim",
        "/SF/Language/Crafting/Foundry_CuringTimeTitle": "[PH] Curing",
      }),
    ).toEqual({ readyToClaim: "Ready To Claim", inProgress: "In Progress", nothingToClaim: "Nothing to Claim" });
  });

  it("keeps the timed crafts the Recipes tab leaves out, so the Forge can name them", () => {
    const dict = { "/SF/Language/Pacts/Bromius": "Bromius", "/SF/Language/Totems/Charm": "Cardinal Charm" };
    const texts = [
      "TypeName=/SF/Types/Recipes/Pacts/BromiusPactBlueprint\nResultItem=/SF/StoreItems/Souls/Bromius/BromiusSoul\nBuildTime=97200\nLocalizeTag=/SF/Language/Pacts/Bromius",
      "TypeName=/SF/Types/Recipes/Totems/CardinalTotemBlueprint\nResultItem=/SF/StoreItems/Upgrades/CardinalTotem\nBuildTime=86400\nLocalizeTag=/SF/Language/Totems/Charm",
      "TypeName=/SF/Types/Recipes/Weapons/SwordReforgeBlueprint\nResultItem=/SF/Weapons/Sword\nBuildTime=0\nLocalizeTag=/SF/Language/Pacts/Bromius",
      "TypeName=/SF/Types/Recipes/Ingots/SteelIngotT3Blueprint\nResultItem=/SF/Types/PickUps/Ingot\nBuildTime=18000",
      "TypeName=/SF/Types/Recipes/Holiday/MysteryBlueprint\nResultItem=/SF/Types/Nameless\nBuildTime=3600",
    ];
    const recipes = { "/SF/Types/Recipes/Ingots/SteelIngotT3Blueprint": {} as RecipeDef };
    expect(buildOtherCrafts(dict, texts, {}, recipes)).toEqual({
      "/SF/Types/Recipes/Pacts/BromiusPactBlueprint": { name: "Bromius", kind: "Pacts", result: "/SF/Souls/Bromius/BromiusSoul", seconds: 97200, icon: null },
      "/SF/Types/Recipes/Totems/CardinalTotemBlueprint": { name: "Cardinal Charm", kind: "Talismans", result: "/SF/Upgrades/CardinalTotem", seconds: 86400, icon: null },
    });
  });
});

describe("Forge notifications", () => {
  let home: string | undefined;
  beforeEach(async () => {
    home = process.env.SFHELPER_HOME;
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-forge-"));
  });
  afterEach(() => {
    if (home === undefined) delete process.env.SFHELPER_HOME;
    else process.env.SFHELPER_HOME = home;
  });

  it("are on until turned off", async () => {
    expect((await getSettings()).forgeNotify).toBe(true);
    await updateSettings({ forgeNotify: false });
    expect((await getSettings()).forgeNotify).toBe(false);
    await updateSettings({ forgeNotify: "yes" });
    expect((await getSettings()).forgeNotify).toBe(false);
  });
});
