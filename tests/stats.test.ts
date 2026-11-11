import { describe, expect, it } from "vitest";
import { aspectManifests, aspectUpgrades, boosterRecords, buildTempers, buildUpgrades, kintsugiDefs, placeArea } from "../src/gamedata/builders";
import { discoveries } from "../src/server/discoveries";

const upgrade = (type: string, op: string, value: number, extra: { damage?: string; symbol?: string } = {}) =>
  `{\nUpgrade={\nUpgradeType=${type}\nOperationType=${op}\nValue=${value}\nDamageType=${extra.damage ?? "DT_ANY"}\nAutoType=1\nValidType=""\nCheckTypeOnInstall=0\nSymbolFilter=${extra.symbol ?? '""'}\nUpgradeObject=""\n}\nSchema={\nLocTag=""\n}\n}`;
const entry = (tag: string, ups: string[], faction = '""', sub = "") =>
  `{\nTag=${tag}\nIcon=/SF/Interface/Graphics/Aspects/Universal/${tag}.png\nUpgrades={\n${ups.join(",\n")}\n}\nSubUpgrades={${sub ? `\n${sub}\n` : ""}}\nRarity=COMMON\nFaction=${faction}\n}`;
const manifest = (origin: string, entries: string[]) =>
  `LocalizeTag=/SF/Language/Menu/Origin${origin}\nUpgradeEntries={\n${entries.join(",\n")}\n}\nItemCompatibility=/SF/Types/Game/SFMeleeWeapon`;
const temper = (key: string) => `LocalizeTag=/T/${key}\nLocalizeDescTag=/T/${key}Desc\nTypeName=/SF/Types/Items/Aspects/Tempers/${key}`;

const dict: Record<string, string> = {
  "/T/ParryWindowMod": "Heightened Parry",
  "/T/ParryWindowModDesc": "Increases Parry window.",
  "/T/FeykinArcanicDamageMod": "Aftershock",
  "/T/FeykinArcanicDamageModDesc": "Grants chance to inflict Arcanic Damage on hit.",
  "/T/OdeReduceDefenseMod": "Bypass",
  "/T/OdeReduceDefenseModDesc": "Reduces foe Defence on first hit.",
  "/SF/Language/Menu/DT_RADIANT": "Arcanic",
  "/SF/Language/Motes/MoteUpgrade_ForcedProcChance": "|CHANCE|% chance to apply |EFFECT|",
  "/SF/Language/Menu/Origin_FEY": "Feykin",
  "/SF/Language/Menu/Origin_ODE": "Ode'n",
  "/SF/Language/Upgrades/AVATAR_ARMOUR": "Armour",
  "/SF/Language/Upgrades/AVATAR_ATTRIBUTE_PRIMARY_COURAGE": "Courage",
  "/SF/Language/Upgrades/AVATAR_HEALTH_MAX": "Maximum Life",
};

describe("Temper numbers from the game files", () => {
  const tree = new Map<string, string | null>([
    ["/SF/Types/Items/Aspects/FeyLightMeleeAspectManifest", "/SF/Types/Items/Aspects/BaseAspectManifest"],
    ["/SF/Types/Items/Aspects/OdeTwoHandedLightMeleeAspectManifest", "/SF/Types/Items/Aspects/BaseAspectManifest"],
    ["/SF/Types/Items/Aspects/Upgrades/DamageOnFullHealth", "/SF/Types/Game/SFArtifactUpgrade"],
    ["/SF/Types/Items/Aspects/Upgrades/ReduceDefenseUniversalAspect", "/SF/Types/Game/SFArtifactUpgrade"],
  ]);
  const texts = [
    manifest("Fey", [
      entry("ParryWindowMod", [upgrade("WEAPON_PARRY_COUNTER_WINDOW", "ADD_BASE", 0.050000001)]),
      entry("FeykinArcanicDamageMod", [upgrade("WEAPON_ELEMENTAL_FX", "ADD", 1, { damage: "DT_RADIANT" }), upgrade("WEAPON_FORCED_PROC_CHANCE", "ADD_BASE", 0.1)], "Feykin"),
    ]),
    manifest("Ode", [
      entry("ParryWindowMod", [upgrade("WEAPON_PARRY_COUNTER_WINDOW", "ADD_BASE", 0.025)]),
      entry("OdeReduceDefenseMod", [upgrade("NONE", "ADD", 0)], "Ode", "Upgrades/ReduceDefenseUniversalAspect"),
    ]),
    'LocalizeTag="[HC] DamageOnFullHealth"\nItemCompatibility=/SF/Types/Game/SFArtifactUpgrade',
    "Rarity=RARE\nItemCompatibility=/SF/Types/Game/SFArtifactUpgrade\nScript={\nScript=ArmorStripOnAttack.lua\n_armorReduction=10\n}",
    "TypeName=/SF/Weapons/Sword\nAspectManifest=/SF/Types/Items/Aspects/FeyLightMeleeAspectManifest",
    "TypeName=/SF/Weapons/Hammer\nAspectManifest=/SF/Types/Items/Aspects/OdeTwoHandedLightMeleeAspectManifest",
    temper("ParryWindowMod"),
    temper("FeykinArcanicDamageMod"),
    temper("OdeReduceDefenseMod"),
  ];
  const weapons = { "/SF/Weapons/Sword": "Espadarte", "/SF/Weapons/Hammer": "Orst-III" };

  it("finds the sub-upgrade records by their place in the folder, labelled or not", () => {
    const subs = aspectUpgrades(texts, tree);
    expect([...subs.keys()]).toEqual(["DamageOnFullHealth", "ReduceDefenseUniversalAspect"]);
    expect(subs.get("ReduceDefenseUniversalAspect")).toContain("_armorReduction=10");
  });

  it("gives each Temper its exact numbers, per weapon where they differ, and its Origin", () => {
    const t = buildTempers(dict, texts, aspectManifests(texts, tree), weapons, aspectUpgrades(texts, tree));
    expect(t.ParryWindowMod).toMatchObject({ name: "Heightened Parry", weapons: ["Espadarte", "Orst-III"] });
    expect(t.ParryWindowMod).not.toHaveProperty("origin");
    expect(t.ParryWindowMod!.stats).toEqual([
      { stats: ["Parry window +0.025s"], weapons: ["Orst-III"] },
      { stats: ["Parry window +0.05s"], weapons: ["Espadarte"] },
    ]);
    expect(t.FeykinArcanicDamageMod).toMatchObject({ origin: "Feykin", stats: [{ stats: ["10% chance to apply Arcanic"], weapons: [] }] });
    expect(t.OdeReduceDefenseMod).toMatchObject({ origin: "Ode'n", stats: [{ stats: ["Armour -10"], weapons: [] }] });
  });
});

describe("Gear numbers from the game files", () => {
  const tree = new Map<string, string | null>([
    ["/SF/Types/Game/CourageBooster", "/SF/Types/Game/SFBoosterUpgrade"],
    ["/SF/Types/Game/CouragePotionBooster", "/SF/Types/Game/SFBoosterUpgrade"],
  ]);
  const booster = (value: number) =>
    `LocalizeTag=/SF/Language/Boosters/CourageBoosterName\nUpgrades={\n{\nUpgradeType=AVATAR_ATTRIBUTE_PRIMARY_COURAGE\nOperationType=ADD\nValue=${value}\nDamageType=DT_ANY\nAutoType=1\nValidType=""\nSymbolFilter=""\n}\n}\nDurationOverride=600`;
  const item = (type: string, tag: string, icon: string) =>
    `ProductCategory=Consumables\nLocalizeTag=${tag}\nLocalizeDescTag=/L/Desc\nIcon=${icon}\nTypeName=/SF/Types/Items/Consumables/${type}`;
  const texts = [
    booster(5),
    booster(10),
    item("Syndicates/ChampionVirtueElixir", "/L/Breath", "/I/Courage.png"),
    "LocalizeTag=/L/Breath\nIcon=/I/Courage.png\nScriptInstance={\nScript=/SF/Scripts/Prototypes/VirtuePotionBooster.lua\n_boostersRes=/SF/Types/Game/CouragePotionBooster\n_duration=3600\n}",
    item("HealingPotion", "/L/Life", "/I/Heal.png"),
    "LocalizeTag=/L/Life\nIcon=/I/Heal.png\nScriptInstance={\nScript=HealingPotion.lua\n_DoChugHeal=1\n_chunkHealPrc=0.30000001\n}",
    item("WevetSeed", "/L/Seed", "/I/Acorn.png"),
  ];
  const names = { ...dict, "/L/Desc": "A description.", "/L/Breath": "Curaidh's Breath", "/L/Life": "Life Elixir", "/L/Seed": "Wevetseed" };

  it("matches each booster to its own record and reads the elixirs' numbers", async () => {
    expect(boosterRecords(texts, tree).get("/SF/Types/Game/CouragePotionBooster")).toContain("Value=10");
    const { gear } = await buildUpgrades(names, texts, null, null, async () => null, async () => null, boosterRecords(texts, tree));
    expect(gear["/SF/Types/Items/Consumables/Syndicates/ChampionVirtueElixir"]!.stats).toEqual(["Courage +10", "Lasts 1 hour"]);
    expect(gear["/SF/Types/Items/Consumables/HealingPotion"]!.stats).toEqual(["Heals 30% of Maximum Life"]);
    expect(gear["/SF/Types/Items/Consumables/WevetSeed"]).not.toHaveProperty("stats");
  });

  it("gives up on boosters rather than guess when the records don't line up", () => {
    expect(boosterRecords(texts.slice(1), tree).size).toBe(0);
  });
});

describe("Joinery pips from the game files", () => {
  const item = (leaf: string, tag: string) =>
    `ProductCategory=Upgrades\nLocalizeTag=${tag}\nLocalizeDescTag=/L/JDesc\nIcon=/I/Kintsugi3.png\nTypeName=/SF/Types/Items/Kintsugi/Weapons/${leaf}`;
  const def = (tag: string, virtue: string, value: number) =>
    `LocalizeTag=${tag}\nIcon=/I/Kintsugi3.png\nUpgrades={\n{\nUpgradeType=WEAPON_ATTUNEMENT_${virtue}\nOperationType=ADD_BASE\nValue=${value}\nDamageType=DT_ANY\nAutoType=1\nValidType=""\nSymbolFilter=""\n}\n}`;
  const T4G = "/SF/Language/Materials/KintsugiMaterialCasterNameT4G";
  const texts = [
    item("KintsugiWeaponUpgradeCasterFeySRS", T4G),
    item("KintsugiWeaponUpgradeCasterSRG", T4G),
    item("KintsugiWeaponUpgradeCasterUC", "/SF/Language/Materials/KintsugiMaterialCasterNameT2"),
    def(T4G, "SPIRIT", 15),
    def(T4G, "GRACE", 15),
    def("/SF/Language/Materials/KintsugiMaterialCasterNameT2", "SPIRIT", 5),
  ];
  const names = {
    "/L/JDesc": "A metal with a blueish iridescence.",
    [T4G]: "Feybalt: Thrice Blessed by Saphene",
    "/SF/Language/Materials/KintsugiMaterialCasterNameT2": "Feybalt: Blessed by Iridis",
    "/SF/Language/Upgrades/AVATAR_ATTRIBUTE_PRIMARY_SPIRIT": "Spirit",
    "/SF/Language/Upgrades/AVATAR_ATTRIBUTE_PRIMARY_GRACE": "Grace",
  };

  it("pairs each Joinery with its own record, even when two share a name, and counts 5 attunement per pip", async () => {
    const { joineries } = await buildUpgrades(names, texts, null, null, async () => null, async () => null, new Map(), kintsugiDefs(texts));
    const at = (leaf: string) => joineries[`/SF/Types/Items/Kintsugi/Weapons/${leaf}`]!.pips;
    expect(at("KintsugiWeaponUpgradeCasterSRG")).toEqual({ virtue: "Grace", count: 3 });
    expect(at("KintsugiWeaponUpgradeCasterFeySRS")).toEqual({ virtue: "Spirit", count: 3 });
    expect(at("KintsugiWeaponUpgradeCasterUC")).toEqual({ virtue: "Spirit", count: 1 });
  });

  it("shows no pips rather than guess when the records don't line up", () => {
    expect(kintsugiDefs(texts.slice(0, 5)).size).toBe(0);
  });
});

describe("Discoveries regions", () => {
  const names = { "/SF/Language/Locations/RegionName05": "Fuirlands" };
  const dungeons = { UnderCity: "Dermak Undercity", Glades: "Glades of Andurin" };

  it("puts each place in its region, and dungeon places under their dungeon", () => {
    expect(placeArea(names, "MorayVillageLocationLoreFragment", dungeons)).toEqual({ region: "Fuirlands" });
    expect(placeArea(names, "UnderCityMillLocationLoreFragment", dungeons)).toEqual({ dungeon: "Dermak Undercity" });
    expect(placeArea(names, "SomethingNewLocationLoreFragment", dungeons)).toEqual({});
  });

  it("passes the region on to the dashboard", () => {
    const d = discoveries({}, {
      MorayVillageLocationLoreFragment: { name: "Moray", memories: 3, map: false, region: "Fuirlands" },
      UnderCityMillLocationLoreFragment: { name: "Pegroot Mill", memories: 0, map: false, dungeon: "Dermak Undercity" },
    });
    expect(d.places.map((p) => [p.name, p.region, p.dungeon])).toEqual([
      ["Moray", "Fuirlands", null],
      ["Pegroot Mill", null, "Dermak Undercity"],
    ]);
  });
});
