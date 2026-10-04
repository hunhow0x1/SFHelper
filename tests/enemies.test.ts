import { describe, expect, it } from "vitest";
import { enemyName, getEnemyNamer, type EnemyData } from "../src/server/enemies";

const data: EnemyData = {
  names: { meleegruntavatar: "Sinecure Soldier", spidereliteavatar: "Grandmother Weaver", tempestbayoravatar: "Tempest Bayor" },
  parents: {
    MeleeGruntAvatar: "GruntAvatarBase",
    MeleeGruntEliteAvatar: "GruntAvatarBase",
    MeleeGruntSpikedMaceEliteAvatar: "MeleeGruntAvatar",
    SpiderEliteSummonAvatar: "SpiderEliteAvatar",
    GruntAvatarBase: "SFNpcAvatar",
  },
};
const T = "/SF/Types/Enemies/X/";

describe("enemy names", () => {
  it("uses the type's own name, else its nearest named ancestor's", () => {
    expect(enemyName(`${T}MeleeGruntAvatar`, data)).toBe("Sinecure Soldier");
    expect(enemyName(`${T}MeleeGruntSpikedMaceEliteAvatar`, data)).toBe("Sinecure Soldier");
    expect(enemyName(`${T}SpiderEliteSummonAvatar`, data)).toBe("Grandmother Weaver");
  });

  it("falls back to variant-free and reordered leaves (old game builds)", () => {
    expect(enemyName(`${T}MeleeGruntEliteAvatar`, data)).toBe("Sinecure Soldier"); // drop "Elite"
    expect(enemyName(`${T}EliteMeleeGruntAvatar`, data)).toBe("Sinecure Soldier"); // reordered
    expect(enemyName(`${T}TempestBayorOldHelmetAvatar`, data)).toBe("Tempest Bayor"); // two variant words
  });

  it("tidies a leaf the game has no name for", () => {
    expect(enemyName(`${T}MendicantKnightProcAvatar`, data)).toBe("Mendicant Knight");
  });

  it("names the bundled data's common enemies as the game does", async () => {
    const name = await getEnemyNamer();
    expect(name("/SF/Types/Enemies/Sinecure/Soldier/MeleeGruntAvatar")).toBe("Sinecure Soldier");
    expect(name("/SF/Types/Enemies/Wildlife/Mockeries/MockeryManAvatar")).toBe("Deadwood Mockery");
    expect(name("/SF/Types/Enemies/Sinecure/Hunter/RangedHunterEliteAvatar")).toBe("Sinecure Scout");
  });
});
