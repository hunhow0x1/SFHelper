import { describe, expect, it } from "vitest";
import { decodeJoinery, fableVirtues, parseBuilds, virtuePoints } from "../src/server/loadouts";
import { parseArmour, parseTalismans } from "../scripts/build_data";
// @ts-expect-error - plain JS build script, no type declarations
import { matchArmourStem } from "../scripts/armour_names.mjs";

const K = "/SF/Types/Items/Kintsugi/Weapons/";

describe("Joinery tiers", () => {
  it("decodes Blessed, Twice and Thrice Blessed per Joinery family", () => {
    const d = (code: string) => {
      const j = decodeJoinery(K + code)!;
      return [j.name, j.tier, j.virtue, j.pips];
    };
    expect(d("KintsugiUpgradeMeleeC")).toEqual(["Verite", "Blessed", "Courage", 1]);
    expect(d("KintsugiUpgradeDefenseUC")).toEqual(["Gildaur", "Blessed", "Spirit", 1]);
    expect(d("KintsugiUpgradeMeleeR")).toEqual(["Verite", "Blessed", "Grace", 1]);
    expect(d("KintsugiUpgradeMeleeSRG")).toEqual(["Verite", "Twice Blessed", "Grace", 2]); // Verite tops out at Twice
    expect(d("KintsugiUpgradeRangedSRCTwo")).toEqual(["Quicksilver", "Twice Blessed", "Courage", 2]);
    expect(d("KintsugiUpgradeRangedSRC")).toEqual(["Quicksilver", "Thrice Blessed", "Courage", 3]);
    expect(d("KintsugiWeaponUpgradeCasterFeySRS")).toEqual(["Feybalt", "Thrice Blessed", "Spirit", 3]);
    expect(d("KintsugiUpgradeDefenseSRG")).toEqual(["Gildaur", "Thrice Blessed", "Grace", 3]);
  });

  it("leaves obsolete reforges without a tier", () => {
    const j = decodeJoinery("/SF/Types/Items/Kintsugi/KintsugiUpgradeD")!;
    expect([j.name, j.tier, j.virtue]).toEqual([null, null, null]);
    expect(decodeJoinery(undefined)).toBeNull();
  });
});

describe("loadout Virtues", () => {
  it("splits 16 + Envoy Rank points by the preset's shares, rounded as the Arsenal does", () => {
    // In-game, less Pact Arts, Talisman and Fable bonuses (eight loadouts):
    expect(virtuePoints(0.25882354, 0.21960784, 17)).toEqual({ Courage: 18, Spirit: 8, Grace: 7 }); // Duelo: Courage takes 2
    expect(virtuePoints(0.21568628, 0, 17)).toEqual({ Courage: 25, Spirit: 7, Grace: 1 }); // Bromius: no Grace share, still 1
    expect(virtuePoints(0.7647059, 0.10196079, 17)).toEqual({ Courage: 5, Spirit: 24, Grace: 4 }); // Oscelda
    expect(virtuePoints(0.16862746, 0.16862746, 17)).toEqual({ Courage: 21, Spirit: 6, Grace: 6 }); // Tethren
    expect(virtuePoints(0.44313726, 0.10980392, 17)).toEqual({ Courage: 15, Spirit: 14, Grace: 4 }); // Duelo, earlier
    expect(virtuePoints(0.16078432, 0.4627451, 17)).toEqual({ Courage: 12, Spirit: 5, Grace: 16 }); // Bromius, earlier
    expect(virtuePoints(0.16862746, 0.66666669, 17)).toEqual({ Courage: 5, Spirit: 6, Grace: 22 }); // Sirin: exactly 21 + 1
    // Corners keep 1 in each other Virtue, and the total adds up.
    expect(virtuePoints(0, 1, 0)).toEqual({ Courage: 1, Spirit: 1, Grace: 14 });
    expect(virtuePoints(1, 0, 0)).toEqual({ Courage: 1, Spirit: 14, Grace: 1 });
    expect(virtuePoints(0, 0, 0)).toEqual({ Courage: 14, Spirit: 1, Grace: 1 });
  });

  it("is null without a stored allocation", () => {
    expect(virtuePoints(undefined, undefined, 17)).toBeNull();
    expect(virtuePoints(0.3, 0.3, undefined)).toBeNull();
  });

  it("counts Fable choices", () => {
    expect(
      fableVirtues({ BonusAttributes: [{ key: "OrengallQuest", value: "AT_COURAGE" }, { key: "BromiusQuest", value: "AT_COURAGE" }] }),
    ).toEqual({ Courage: 2, Spirit: 0, Grace: 0 });
  });

  it("reads Talisman Virtues from the wiki's armour data, by ItemType", () => {
    const lua = `return {\n\t["Paragon Periapt"] = {\n\t\t\tSlot = "Talisman",\n\t\t\tStats = {\n\t\t\t\t\tCourage = 3, Grace = 3, Spirit = 3\n\t\t\t}\n\t},\n\t["Bascinet"] = {\n\t\t\tSlot = "Helm",\n\t\t\tStats = { PhysicalDefence = 3 }\n\t},\n}`;
    expect(parseTalismans(lua)).toEqual({ PrimordialTotem: { name: "Paragon Periapt", Courage: 3, Spirit: 3, Grace: 3 } });
  });
});

describe("loadout armour", () => {
  it("reads each loadout's Helm, Cuirass, Leggings and Talisman from its Pact's appearance", () => {
    const oid = (n: number) => ({ $oid: n.toString(16).padStart(24, "0") });
    const id = (n: number) => oid(n).$oid;
    const raw = {
      WeaponSkins: [
        { ItemType: "/SF/Upgrades/Skins/Helmets/MendicantKingHelmet", ItemId: oid(1) },
        { ItemType: "/SF/Upgrades/Skins/Body/MendicantKingBody", ItemId: oid(2) },
        { ItemType: "/SF/Upgrades/Skins/Totem/PrimordialTotem", ItemId: oid(3) },
      ],
      Suits: [{
        ItemType: "/SF/Souls/Fencer/FencerSoul",
        ItemId: oid(10),
        // Config 1 is this loadout's appearance (cus); a default piece is stored by path.
        Configs: [{ Skins: [] }, { Skins: [id(1), "", id(2), "/SF/Upgrades/Skins/Legs/StarterLegs", "/SF/Upgrades/Skins/Hair/FemaleShortHairA", id(3)] }],
      }],
      LoadOutPresets: { NORMAL: [{ n: "Duelo", s: { ItemId: oid(10), mod: 0, cus: 1 } }] },
    };
    const [b] = parseBuilds(raw);
    expect(b!.armour).toEqual({
      helm: "/SF/Upgrades/Skins/Helmets/MendicantKingHelmet",
      cuirass: "/SF/Upgrades/Skins/Body/MendicantKingBody",
      leggings: "/SF/Upgrades/Skins/Legs/StarterLegs",
    });
    expect(b!.talisman).toBe("/SF/Upgrades/Skins/Totem/PrimordialTotem");
  });

  it("reads armour stats from the wiki's armour data, by in-game name", () => {
    const lua = `return {\n\t["Bascinet of The Mendicant King"] = {\n\t\t\tSlot = "Helm",\n\t\t\tArmorSet = "Mendicant King",\n\t\t\tRarity = "Rare",\n\t\t\tStats = {\n\t\t\t\t\tPhysicalDefence = 3,\n\t\t\t\t\tMagickDefence = 1,\n\t\t\t\t\tStabilityIncrease = 3,\n\t\t\t\t\tVirtueReq = "17 C"\n\t\t\t}\n\t},\n\t["Paragon Periapt"] = {\n\t\t\tSlot = "Talisman",\n\t\t\tStats = { Courage = 3 }\n\t},\n}`;
    expect(parseArmour(lua)).toEqual({
      "Bascinet of The Mendicant King": {
        slot: "Helm", set: "Mendicant King", rarity: "Rare", physical: 3, magick: 1, stability: 3,
        requires: { virtue: "Courage", value: 17 },
      },
    });
  });

  it("matches armour leaves to their names despite DE's naming differences", () => {
    const stems = ["ForgetFireBody", "ForgetFireBodyAlt", "CircadeHelm", "TuvalkaneLegs", "TuvalkanetBody", "ThawTideSinecureHelmet", "BromiusHelmet", "NoHelmet", "WazzardBody"];
    expect(matchArmourStem("ForgetFireAltBody", "Body", stems)).toBe("ForgetFireBodyAlt");
    expect(matchArmourStem("CircadeHelmet", "Helmets", stems)).toBe("CircadeHelm");
    expect(matchArmourStem("TuvalkanelLegs", "Legs", stems)).toBe("TuvalkaneLegs");
    expect(matchArmourStem("TuvalkaneBody", "Body", stems)).toBe("TuvalkanetBody");
    expect(matchArmourStem("ThawtideHelmet", "Helmets", stems)).toBe("ThawTideSinecureHelmet");
    expect(matchArmourStem("BromiusClosedHelmet", "Helmets", stems)).toBe("BromiusHelmet");
    // Internal types with no player-facing name stay unmatched.
    expect(matchArmourStem("BaseHelmetVisionNoHair", "Helmets", stems)).toBeNull();
    expect(matchArmourStem("GrandfatherBody", "Body", stems)).toBeNull();
  });
});
