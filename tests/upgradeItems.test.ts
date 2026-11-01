import { describe, expect, it } from "vitest";
import { parseUpgradeItems } from "../src/server/upgradeItems";

describe("runes, joineries and gear", () => {
  const raw = {
    Upgrades: [
      { UpgradeFingerprint: "{\"lvl\":3}", ItemType: "/SF/Upgrades/Runes/Weapon/Bow/RainRune" },
      { UpgradeFingerprint: "{\"lvl\":1}", ItemType: "/SF/Upgrades/Runes/Weapon/Bow/StarterRune" },
      { UpgradeFingerprint: "{\"lvl\":3}", ItemType: "/SF/Upgrades/Runes/Weapon/Bow/StarterRune" },
      { UpgradeFingerprint: "{\"lvl\":2,\"virtue\":\"AT_COURAGE\"}", ItemType: "/SF/Upgrades/Totems/Bear/BearTotem" },
    ],
    RawUpgrades: [
      { ItemCount: 12, ItemType: "/SF/Upgrades/Runes/Weapon/Bow/StarterRune" },
      { ItemCount: 39, ItemType: "/SF/Upgrades/Runes/Weapon/LongBlade/StarterRune" },
      { ItemCount: 150, ItemType: "/SF/Types/Items/Kintsugi/Weapons/KintsugiUpgradeMeleeC" },
      { ItemCount: 30, ItemType: "/SF/Types/Items/Kintsugi/KintsugiUpgradeA" },
      { ItemCount: 1, ItemType: "/SF/Upgrades/Dendria/PactWords/DendriaPactWordB" },
      { ItemCount: 0, ItemType: "/SF/Types/Items/Kintsugi/KintsugiUpgradeB" },
    ],
    Consumables: [
      { ItemCount: 99, ItemType: "/SF/Types/Items/Consumables/VerminiaPotion" },
      { ItemCount: 8, ItemType: "/SF/Types/Items/Consumables/Tackle/FishLureUncommon" },
    ],
    EquippedGear: ["/SF/Types/Items/Consumables/VerminiaPotion", "/SF/Types/Items/Consumables/HealingPotion"],
  };

  it("keeps ranked runes and their unranked copies together", () => {
    expect(parseUpgradeItems(raw).runes).toEqual([
      { type: "/SF/Upgrades/Runes/Weapon/Bow/RainRune", ranks: [3], unranked: 0 },
      { type: "/SF/Upgrades/Runes/Weapon/Bow/StarterRune", ranks: [3, 1], unranked: 12 },
      { type: "/SF/Upgrades/Runes/Weapon/LongBlade/StarterRune", ranks: [], unranked: 39 },
    ]);
  });

  it("counts joineries, and gear with what's equipped", () => {
    const u = parseUpgradeItems(raw);
    expect(u.joineries).toEqual([
      { type: "/SF/Types/Items/Kintsugi/Weapons/KintsugiUpgradeMeleeC", count: 150 },
      { type: "/SF/Types/Items/Kintsugi/KintsugiUpgradeA", count: 30 },
    ]);
    expect(u.gear).toEqual([
      { type: "/SF/Types/Items/Consumables/VerminiaPotion", count: 99, equipped: true },
      { type: "/SF/Types/Items/Consumables/Tackle/FishLureUncommon", count: 8, equipped: false },
      { type: "/SF/Types/Items/Consumables/HealingPotion", count: 0, equipped: true },
    ]);
    expect(parseUpgradeItems({})).toEqual({ runes: [], joineries: [], gear: [] });
  });
});
