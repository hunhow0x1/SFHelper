import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFounderItems, factionIconPaths } from "../src/gamedata/builders";
import { newStarredTotems, totemNamer, type OwnedTotem } from "../src/server/totems";
import { getSettings, updateSettings } from "../src/server/settings";
import { getNames } from "../src/server/names";

const PACK = `ProductCategory=Packages
MarketSubcategoryOverride=founders
LocalizeTag=/SF/Language/Vendor/Founder_Courage
PackageComponents={
{
TypeName=/SF/StoreItems/Souls/Default/PothiaSoul
PurchaseQuantity=1
},
{
TypeName=/SF/StoreItems/Weapons/Melee/OneHand/PothiaLongSword/PothiaLongSwordMeleeWeapon
PurchaseQuantity=1
}
}
PremiumPrice=1`;

describe("Founder's items from the game files", () => {
  it("lists what came in the Founder packs, and nothing from other bundles", () => {
    const other = PACK.replace("MarketSubcategoryOverride=founders\n", "").replace("PothiaSoul", "StagSoul");
    expect(buildFounderItems([PACK, other])).toEqual([
      "/SF/Souls/Default/PothiaSoul",
      "/SF/Weapons/Melee/OneHand/PothiaLongSword/PothiaLongSwordMeleeWeapon",
    ]);
  });
});

describe("faction icons from the game files", () => {
  it("takes each faction's own icon from its record", () => {
    expect(
      factionIconPaths([
        "SyndicateName=/SF/Language/Syndicates/ChampionName\nIconTexture=/SF/Interface/Graphics/Factions/Champion/ChampionFaction.png\nMapIconTexture=/x.png",
        "SyndicateName=/SF/Language/Syndicates/OdeName\nIconTexture=/SF/Interface/Graphics/HUD/SiegePopUp/OdeIcon.png",
        "SyndicateName=/SF/Language/Syndicates/ArbitersName\nIconTexture=/Lotus/Arbiters.png",
      ]),
    ).toEqual({
      ChampionSyndicate: "/SF/Interface/Graphics/Factions/Champion/ChampionFaction.png",
      OdeSyndicate: "/SF/Interface/Graphics/HUD/SiegePopUp/OdeIcon.png",
    });
  });
});

describe("starred Totems", () => {
  const totem = (id: string, type: string, extra: Partial<OwnedTotem> = {}): OwnedTotem => ({ id, type, rank: 1, virtue: "Grace", grip: "Universal", equippedOn: [], ...extra });
  const nameOf = totemNamer({ "Binky Kick": { types: ["/SF/Upgrades/Totems/AoeCollect"] }, "Rivers Revive": { types: ["/SF/Upgrades/Totems/HealCast"] } }, { ArmourBuffCast: "Armour Coat" });

  it("names Totems the way the Totems tab does", () => {
    expect(nameOf("/SF/Upgrades/Totems/HealCast")).toBe("Rivers Revive");
    expect(nameOf("/SF/Upgrades/Totems/ArmourBuffCast")).toBe("Armour Coat");
    expect(nameOf("/SF/Upgrades/Totems/NewThing")).toBe("New Thing");
  });

  it("notices a newly obtained starred Totem, once, and ignores the rest", () => {
    const before = [totem("a", "/SF/Upgrades/Totems/AoeCollect"), totem("b", "/SF/Upgrades/Totems/ArmourBuffCast")];
    const after = [...before, totem("c", "/SF/Upgrades/Totems/AoeCollect", { virtue: "Spirit" }), totem("d", "/SF/Upgrades/Totems/ArmourBuffCast"), totem("e", "/SF/Upgrades/Totems/HealCast")];
    expect(newStarredTotems(before, after, ["Binky Kick", "Rivers Revive"], nameOf).map((t) => t.id)).toEqual(["c", "e"]);
    expect(newStarredTotems(after, after, ["Binky Kick"], nameOf)).toEqual([]);
    expect(newStarredTotems(null, after, ["Binky Kick"], nameOf)).toEqual([]);
  });

  it("doesn't count a Totem that only changed when two were fused into one", () => {
    const before = [totem("a", "/SF/Upgrades/Totems/AoeCollect"), totem("b", "/SF/Upgrades/Totems/AoeCollect")];
    const after = [totem("f", "/SF/Upgrades/Totems/AoeCollect", { rank: 2 })];
    expect(newStarredTotems(before, after, ["Binky Kick"], nameOf)).toEqual([]);
  });
});

describe("settings for the new views", () => {
  let home: string | undefined;
  beforeEach(async () => {
    home = process.env.SFHELPER_HOME;
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-collection-"));
  });
  afterEach(() => {
    if (home === undefined) delete process.env.SFHELPER_HOME;
    else process.env.SFHELPER_HOME = home;
  });

  it("shows Founder's items until hidden, and keeps starred Totem names", async () => {
    expect(await getSettings()).toMatchObject({ hideFounders: false, totemNotify: true, totemWatch: [] });
    await updateSettings({ hideFounders: true, totemWatch: ["Binky Kick", "Rose's Bodkin", "Binky Kick"] });
    expect(await getSettings()).toMatchObject({ hideFounders: true, totemWatch: ["Binky Kick", "Rose's Bodkin"] });
    await updateSettings({ totemWatch: ["<script>"] });
    expect((await getSettings()).totemWatch).toEqual(["Binky Kick", "Rose's Bodkin"]);
  });
});

describe("names.json reaching the dashboard", () => {
  let dir: string | undefined;
  beforeEach(async () => {
    dir = process.env.SFHELPER_DATA_DIR;
    process.env.SFHELPER_DATA_DIR = await mkdtemp(join(tmpdir(), "sfh-names-"));
  });
  afterEach(() => {
    if (dir === undefined) delete process.env.SFHELPER_DATA_DIR;
    else process.env.SFHELPER_DATA_DIR = dir;
  });

  it("passes on the Forge's words and the Founder's items", async () => {
    await writeFile(
      join(process.env.SFHELPER_DATA_DIR!, "names.json"),
      JSON.stringify({ items: {}, crafting: { readyToClaim: "Ready To Claim" }, founders: ["/SF/Souls/Default/PothiaSoul", 7, "nope"] }),
    );
    const names = await getNames();
    expect(names.crafting).toEqual({ readyToClaim: "Ready To Claim" });
    expect(names.founders).toEqual(["/SF/Souls/Default/PothiaSoul"]);
  });
});
