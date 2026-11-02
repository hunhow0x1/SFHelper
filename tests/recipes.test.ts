import { describe, expect, it } from "vitest";
import { buildRecipes, parseCraftingTable, recipeKind } from "../src/gamedata/builders";
import { wikiEntry } from "../src/gamedata/update";
import { parseCrafting } from "../src/server/recipes";

const recipe = (type: string, tag: string, extra: string, ingredients: [string, number, string?][]) =>
  [
    `LocalizeTag=${tag}`,
    `LocalizeDescTag=${tag}Desc`,
    `TypeName=${type}`,
    "ResultItem=/SF/StoreItems/Types/Items/Consumables/Thing",
    extra,
    "Ingredients={",
    ...ingredients.map(([t, n, alt = ""]) => `{\nItemType=${t}\nAlternativeItemTypes={${alt}}\nItemCount=${n}\nExactQualityRequired=IQ_NONE\n},`),
    "}",
  ].join("\n");

describe("recipes from the game files", () => {
  it("keeps Verminia's brews and Chordstones only", () => {
    expect(recipeKind("/SF/Types/Recipes/Elixers/ChampionElixirRecipe", "Curaidh's Breath")).toEqual(["Brewing", "Elixirs"]);
    expect(recipeKind("/SF/Types/Recipes/ColorPalettes/X", "Epona")).toEqual(["Brewing", "Palettes"]);
    expect(recipeKind("/SF/Types/Recipes/Consumeables/PetFood/X", "Canid Kibble")).toEqual(["Brewing", "Pup Treats"]);
    expect(recipeKind("/SF/Types/Recipes/Ingots/Bundles/X", "Hushed Chordstone")).toEqual(["Blacksmith", "Chordstones"]);
    expect(recipeKind("/SF/Types/Recipes/Quests/OrlickProgression/IronIngotBlueprint", "Hushed Chordstone")).toEqual(["Blacksmith", "Chordstones"]);
    expect(recipeKind("/SF/Types/Recipes/Quests/OrlickProgression/BrassIngotBlueprint", "Brass Ingot")).toBeNull();
    expect(recipeKind("/SF/Types/Recipes/Weapons/X", "Vasp-IV")).toBeNull();
    expect(recipeKind("/SF/Types/Recipes/WeaponQuality/ChaosRerollBlueprint", "Chaos Chordstone")).toBeNull();
  });

  it("reads ingredients, costs and descriptions", () => {
    const dict = {
      "/L/Crate": "Hushed Chordstone",
      "/L/CrateDesc": "A cratesweight of |AMOUNT| Hushed Chordstone",
      "/L/Iron": "Scrap Iron",
    };
    const texts = [
      recipe("/SF/Types/Recipes/Ingots/Bundles/IronIngotBundleSmallBlueprint", "/L/Crate", "NumToGive=5\nBuildTime=6480\nBuildPrice=1000\nConsumeOnUse=0", [
        ["/SF/Types/PickUps/Resources/ScrapMetals/ScrapIronResource", 90],
        ["/SF/Types/PickUps/Resources/Organics/WhispPlanksResource", 45, "\n/SF/Types/PickUps/Resources/Organics/OtherPlanksResource\n"],
      ]),
      "TypeName=/SF/Types/PickUps/Resources/ScrapMetals/ScrapIronResource\nLocalizeTag=/L/Iron",
    ];
    const r = buildRecipes(dict, texts, { WhispPlanks: "Whisprig" })["/SF/Types/Recipes/Ingots/Bundles/IronIngotBundleSmallBlueprint"];
    expect(r).toMatchObject({ name: "Hushed Chordstone", station: "Blacksmith", kind: "Chordstones", gives: 5, consumed: false, fragments: 1, dracs: 1000, seconds: 6480 });
    expect(r?.desc).toBe("A cratesweight of 5 Hushed Chordstone");
    expect(r?.ingredients).toEqual([
      { type: "/SF/Types/PickUps/Resources/ScrapMetals/ScrapIronResource", name: "Scrap Iron", count: 90 },
      { type: "/SF/Types/PickUps/Resources/Organics/WhispPlanksResource", name: "Whisprig", count: 45, alt: ["/SF/Types/PickUps/Resources/Organics/OtherPlanksResource"] },
    ]);
  });

  it("matches the wiki's Bond requirements by name", () => {
    const table = parseCraftingTable(
      ['["Hushed Chordstone"]= {', '\tBondReq= "1",', "\tIngredients= {}", "},", '["Hushed Chordstone (Cratesweight)"]= {', '\tBondReq= "4",', "\tIngredients= {}", "},",
        '["The Cogah (Consumable)"]= {', '\tBondReq= "2",', "\tIngredients= {}", "},", '["Epona\'s Forests"]= {', '\tBondReq= "",', "\tIngredients= {}", "},"].join("\n"),
    );
    expect(wikiEntry(table, { name: "Hushed Chordstone", gives: 1 })).toBe(1);
    expect(wikiEntry(table, { name: "Hushed Chordstone", gives: 5 })).toBe(4);
    expect(wikiEntry(table, { name: "The Cogah", gives: 1 })).toBe(2);
    expect(wikiEntry(table, { name: "Epona", gives: 1 })).toBeNull();
    expect(wikiEntry(table, { name: "Mistmaker", gives: 1 })).toBeUndefined();
  });
});

describe("what the inventory says about crafting", () => {
  it("counts recipes, stock and Dracs, and shows Bond ranks as the game does", () => {
    const state = parseCrafting({
      RegularCredits: 2500,
      Recipes: [{ ItemType: "/R/Elixir", ItemCount: 1 }, { ItemType: "/R/Gone", ItemCount: 0 }],
      MiscItems: [{ ItemType: "/I/Sap", ItemCount: 4 }, { ItemType: "/I/Iron", ItemCount: 10 }],
      Consumables: [{ ItemType: "/I/Iron", ItemCount: 2 }],
      Ancestors: [
        { ItemType: "/SF/Types/Game/Ancestors/Verminia/VerminiaAncestor", Rank: 1 },
        { ItemType: "/SF/Types/Game/Ancestors/Tuvalkane/TuvalkaneAncestor", Rank: 3 },
        { ItemType: "/SF/Types/Game/Ancestors/MestraCarmo/MestraCarmoAncestor", Rank: -1 },
      ],
    });
    expect(state).toEqual({
      recipes: { "/R/Elixir": 1 },
      stock: { "/I/Sap": 4, "/I/Iron": 12 },
      dracs: 2500,
      bond: { Verminia: 2, Tuvalkane: 4 },
    });
  });
});
