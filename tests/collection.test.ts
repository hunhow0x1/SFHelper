import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFounderItems, factionIconPaths } from "../src/gamedata/builders";
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

  it("shows Founder's items until hidden", async () => {
    expect(await getSettings()).toMatchObject({ hideFounders: false });
    await updateSettings({ hideFounders: true });
    expect(await getSettings()).toMatchObject({ hideFounders: true });
  });

  it("drops the Totem stars older versions saved", async () => {
    await writeFile(join(process.env.SFHELPER_HOME!, "settings.json"), JSON.stringify({ hideFounders: true, totemNotify: true, totemWatch: ["Binky Kick"] }));
    const s = await getSettings();
    expect(s.hideFounders).toBe(true);
    expect(s).not.toHaveProperty("totemWatch");
    expect(s).not.toHaveProperty("totemNotify");
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
