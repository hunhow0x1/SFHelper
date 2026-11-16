import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecipes, recipeKind, type RecipeDef } from "../src/gamedata/builders";
import { newlyReady, pactBlock, parseCrafting, readyRecipes, recipeTimes, recipeVerb, type CraftingState } from "../src/server/recipes";
import { getSettings, updateSettings } from "../src/server/settings";

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
  it("keeps Verminia's brews, Chordstones, weapons, armour and Pacts", () => {
    expect(recipeKind("/SF/Types/Recipes/Elixers/ChampionElixirRecipe", "Curaidh's Breath")).toEqual(["Brewing", "Elixirs"]);
    expect(recipeKind("/SF/Types/Recipes/ColorPalettes/X", "Epona")).toEqual(["Brewing", "Palettes"]);
    expect(recipeKind("/SF/Types/Recipes/Consumeables/PetFood/X", "Canid Kibble")).toEqual(["Brewing", "Pup Treats"]);
    expect(recipeKind("/SF/Types/Recipes/Ingots/Bundles/X", "Hushed Chordstone")).toEqual(["Blacksmith", "Chordstones"]);
    expect(recipeKind("/SF/Types/Recipes/Quests/OrlickProgression/IronIngotBlueprint", "Hushed Chordstone")).toEqual(["Blacksmith", "Chordstones"]);
    expect(recipeKind("/SF/Types/Recipes/Quests/OrlickProgression/BrassIngotBlueprint", "Brass Ingot")).toBeNull();
    expect(recipeKind("/SF/Types/Recipes/Weapons/X", "Vasp-IV")).toEqual(["Blacksmith", "Weapons"]);
    expect(recipeKind("/SF/Types/Recipes/Armor/BromiusHelmBlueprint", "Bromius' Helm")).toEqual(["Blacksmith", "Armour"]);
    expect(recipeKind("/SF/Types/Recipes/Pacts/BromiusPactBlueprint", "Bromius")).toEqual(["Blacksmith", "Pacts"]);
    expect(recipeKind("/SF/Types/Recipes/Weapons/XReforgeBlueprint", "Vasp-IV")).toBeNull();
    expect(recipeKind("/SF/Types/Recipes/WeaponQuality/ChaosRerollBlueprint", "Chaos Chordstone")).toBeNull();
  });

  it("adds the slot, Virtue scaling and requirements of weapons and armour", () => {
    const blueprint = (type: string, tag: string, result: string) =>
      `LocalizeTag=${tag}\nTypeName=${type}\nResultItem=${result}\nNumRequired=3\nIngredients={\n{\nItemType=/SF/Types/PickUps/Resources/IronResource\nAlternativeItemTypes={}\nItemCount=15\nExactQualityRequired=IQ_NONE\n}\n}\nBuildTime=72000\nBuildPrice=3500`;
    const texts = [
      blueprint("/SF/Types/Recipes/Weapons/Melee/Blueprints/SwordBlueprint", "/L/Sword", "/SF/StoreItems/Weapons/Melee/Sword/SwordWeapon"),
      "ProductCategory=Melee\nTypeName=/SF/Weapons/Melee/Sword/SwordWeapon\nRequirements={\nAT_COURAGE=14\nAT_SPIRIT=9\n}\nAttunements={\nAT_COURAGE=15\nAT_SPIRIT=10\n}\nAttunementsCap={\nAT_GRACE=25\n}",
      blueprint("/SF/Types/Recipes/Armor/HelmBlueprint", "/L/Helm", "/SF/StoreItems/Upgrades/Skins/Helmets/Helm"),
      "ProductCategory=WeaponSkins\nTypeName=/SF/Upgrades/Skins/Helmets/Helm\nRequirements={\nAT_GRACE=19\n}\nAttunements={\nPhysical={\nAT_GRACE=3\n}\nMagick={\nAT_SPIRIT=1\n}\n}",
    ];
    const out = buildRecipes({ "/L/Sword": "Cenotaph", "/L/Helm": "Shrike's Helm" }, texts, {});
    expect(out["/SF/Types/Recipes/Weapons/Melee/Blueprints/SwordBlueprint"]).toMatchObject({ kind: "Weapons", slot: "Primary", scaling: ["Courage", "Spirit"], requires: { Courage: 14, Spirit: 9 }, fragments: 3 });
    expect(out["/SF/Types/Recipes/Armor/HelmBlueprint"]).toMatchObject({ kind: "Armour", slot: "Helm", scaling: ["Grace", "Spirit"], requires: { Grace: 19 } });
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

  it("keeps Pacts that have their own name, and skips the unnamed placeholder", () => {
    const pact = (leaf: string, head: string, result: string) =>
      `${head}TypeName=/SF/Types/Recipes/Pacts/${leaf}\nRarity=UNCOMMON\nResultItem=${result}\nIngredients={\n{\nItemType=/SF/Types/PickUps/Resources/IronResource\nAlternativeItemTypes={}\nItemCount=55\nExactQualityRequired=IQ_NONE\n}\n}\nBuildTime=97200`;
    const texts = [
      pact("BromiusPactBlueprint", "LocalizeTag=/L/Bromius\nLocalizeDescTag=/L/BromiusDesc\n", "/SF/StoreItems/Souls/Bromius/BromiusSoul"),
      pact("FencerPactBlueprint", "LocalizeTag=/L/Duelo\nNumRequired=3\n", "/SF/StoreItems/Souls/Fencer/FencerSoul"),
      pact("FeyPactBlueprint", "Icon=/SF/Fey.png\n", "/SF/StoreItems/Souls/Default/BaseSoul"),
    ];
    const out = buildRecipes({ "/L/Bromius": "Bromius", "/L/BromiusDesc": "The Arbearer.", "/L/Duelo": "Duelo" }, texts, { BaseSoul: "Pact" });
    expect(Object.keys(out)).toEqual(["/SF/Types/Recipes/Pacts/BromiusPactBlueprint", "/SF/Types/Recipes/Pacts/FencerPactBlueprint"]);
    expect(out["/SF/Types/Recipes/Pacts/BromiusPactBlueprint"]).toMatchObject({
      name: "Bromius", station: "Blacksmith", kind: "Pacts", result: "/SF/Souls/Bromius/BromiusSoul", fragments: 1, consumed: true, dracs: 0, seconds: 97200, desc: "The Arbearer.",
    });
    expect(out["/SF/Types/Recipes/Pacts/FencerPactBlueprint"]?.fragments).toBe(3);
  });
});

describe("what the inventory says about crafting", () => {
  it("counts recipes, stock, copies held and Dracs, and shows Bond ranks as the game does", () => {
    const state = parseCrafting({
      RegularCredits: 2500,
      Recipes: [{ ItemType: "/R/Elixir", ItemCount: 1 }, { ItemType: "/R/Gone", ItemCount: 0 }],
      MiscItems: [{ ItemType: "/I/Sap", ItemCount: 4 }, { ItemType: "/I/Iron", ItemCount: 10 }],
      Consumables: [{ ItemType: "/I/Iron", ItemCount: 2 }],
      Suits: [{ ItemType: "/SF/Souls/Fencer/FencerSoul" }],
      Melee: [{ ItemType: "/SF/Weapons/Sword" }, { ItemType: "/SF/Weapons/Sword" }],
      LongGuns: [{ ItemType: "/SF/Weapons/Bow" }],
      WeaponSkins: [{ ItemType: "/SF/Upgrades/Skins/Helmets/Helm" }],
      FlavourItems: [{ ItemType: "/SF/Types/Items/ColorPalettes/Epona" }],
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
      pending: [],
      owned: {
        "/SF/Souls/Fencer/FencerSoul": 1,
        "/SF/Weapons/Sword": 2,
        "/SF/Weapons/Bow": 1,
        "/SF/Upgrades/Skins/Helmets/Helm": 1,
        "/SF/Types/Items/ColorPalettes/Epona": 1,
      },
    });
  });
});

describe("starred recipes", () => {
  const def = (extra: Partial<RecipeDef>): RecipeDef => ({
    name: "Curaidh's Breath", station: "Brewing", kind: "Elixirs", result: "/R/Out", rarity: null, fragments: 1, consumed: false,
    gives: 1, dracs: 100, seconds: 0, ingredients: [{ type: "/I/Sap", name: "Sap", count: 2 }], desc: null, icon: null, ...extra,
  });
  const state = (extra: Partial<CraftingState>): CraftingState => ({ recipes: { "/R/A": 1 }, stock: { "/I/Sap": 5 }, dracs: 1000, bond: {}, pending: [], owned: {}, ...extra });

  it("works out how many times a recipe can be crafted, as the Recipes tab does", () => {
    expect(recipeTimes("/R/A", def({}), state({}))).toBe(2);
    expect(recipeTimes("/R/A", def({ ingredients: [{ type: "/I/Sap", name: "Sap", count: 2, alt: ["/I/OldSap"] }] }), state({ stock: { "/I/Sap": 1, "/I/OldSap": 3 } }))).toBe(2);
    expect(recipeTimes("/R/A", def({}), state({ dracs: 150 }))).toBe(1);
    expect(recipeTimes("/R/A", def({ consumed: true, fragments: 3 }), state({ recipes: { "/R/A": 2 } }))).toBe(0);
    expect(recipeTimes("/R/B", def({}), state({}))).toBe(0);
  });

  it("doesn't count a Pact you already own or have curing as craftable", () => {
    const pact = def({ station: "Blacksmith", kind: "Pacts", result: "/SF/Souls/Fencer/FencerSoul", consumed: true, fragments: 3, dracs: 0 });
    const ready = state({ recipes: { "/R/A": 3 } });
    expect(recipeTimes("/R/A", pact, ready)).toBe(1);
    expect(pactBlock("/R/A", pact, ready)).toBeNull();
    expect(pactBlock("/R/A", pact, { ...ready, owned: { "/SF/Souls/Fencer/FencerSoul": 1 } })).toBe("owned");
    expect(recipeTimes("/R/A", pact, { ...ready, owned: { "/SF/Souls/Fencer/FencerSoul": 1 } })).toBe(0);
    expect(pactBlock("/R/A", pact, { ...ready, pending: [{ id: "x", recipe: "/R/A", completes: 1 }] })).toBe("curing");
    expect(recipeTimes("/R/A", pact, { ...ready, pending: [{ id: "x", recipe: "/R/A", completes: 1 }] })).toBe(0);
    expect(pactBlock("/R/A", def({}), { ...ready, owned: { "/R/Out": 1 } })).toBeNull();
    expect(recipeVerb(pact)).toBe("forge");
  });

  it("names only starred recipes that just became craftable", () => {
    const defs = { "/R/A": def({}), "/R/B": def({ ingredients: [{ type: "/I/Iron", name: "Iron", count: 1 }] }) };
    const before = readyRecipes(defs, state({ recipes: { "/R/A": 1, "/R/B": 1 } }));
    expect([...before]).toEqual(["/R/A"]);
    const after = readyRecipes(defs, state({ recipes: { "/R/A": 1, "/R/B": 1 }, stock: { "/I/Sap": 5, "/I/Iron": 1 } }));
    expect(newlyReady(before, after, ["/R/A", "/R/B"])).toEqual(["/R/B"]);
    expect(newlyReady(before, after, ["/R/A"])).toEqual([]);
    expect(newlyReady(null, after, ["/R/A", "/R/B"])).toEqual([]);
  });

  describe("settings", () => {
    let home: string | undefined;
    beforeEach(async () => {
      home = process.env.SFHELPER_HOME;
      process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-recipes-"));
    });
    afterEach(() => {
      if (home === undefined) delete process.env.SFHELPER_HOME;
      else process.env.SFHELPER_HOME = home;
    });

    it("saves starred recipes and the two new toggles", async () => {
      expect(await getSettings()).toMatchObject({ recipeWatch: [], recipeNotify: true, blessedNotify: false });
      await updateSettings({ recipeWatch: ["/SF/Types/Recipes/A", "<img onerror=x>"] });
      expect((await getSettings()).recipeWatch).toEqual([]);
      await updateSettings({ recipeWatch: ["/SF/Types/Recipes/A", "/SF/Types/Recipes/A"], recipeNotify: false, blessedNotify: true });
      expect(await getSettings()).toMatchObject({ recipeWatch: ["/SF/Types/Recipes/A"], recipeNotify: false, blessedNotify: true });
    });
  });
});
