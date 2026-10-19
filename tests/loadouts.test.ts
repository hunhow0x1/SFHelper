import { describe, expect, it } from "vitest";
import { decodeJoinery, fableVirtues, virtuePoints } from "../src/server/loadouts";
import { parseTalismans } from "../scripts/build_data";

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
    // In-game, less Pact Arts, Talisman and Fable bonuses:
    expect(virtuePoints(0.44313726, 0.10980392, 17)).toEqual({ Courage: 15, Spirit: 14, Grace: 4 }); // Duelo
    expect(virtuePoints(0.16078432, 0.4627451, 17)).toEqual({ Courage: 12, Spirit: 5, Grace: 16 }); // Bromius
    // Corners stay whole and add up.
    const v = virtuePoints(0.66666669, 0.16862746, 17)!;
    expect(v).toEqual({ Courage: 5, Spirit: 22, Grace: 6 });
    expect(virtuePoints(0, 1, 0)).toEqual({ Courage: 0, Spirit: 0, Grace: 16 });
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
