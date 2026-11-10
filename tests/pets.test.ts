import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePets } from "../src/server/pets";
import { buildPetText } from "../src/gamedata/builders";
import { getNames } from "../src/server/names";

const CUAN = {
  ItemType: "/SF/Types/Game/Pets/OmenWolfs/WolfPowerSuits/WolfCubPetPlayfulPowerSuit",
  ItemId: { $oid: "6aaec1b8e3bd0e40510f69a6" },
  Details: {
    Name: "/SF/Language/Quests/OrengallPupName3",
    Maturity: 0,
    Energy: 0,
    Bond: 6215,
    Temperment: "TEMPERMENT_PLAYFUL",
    Guard: 4214,
    Speed: 3192,
    Stamina: 2820,
    Search: 4668,
    Support: 625,
    MealsEaten: 1,
    SnacksEaten: 0,
    RestDate: { $date: { $numberLong: "1794347873000" } },
    NeedsRest: true,
    GuardSkill: 3,
    SearchSkill: 3,
    SpeedSkill: 2,
    StaminaSkill: 2,
    SupportSkill: 1,
    IsAdult: false,
  },
};

describe("the Wolfpup", () => {
  it("reads the pup's trained levels, care state and name tag from the inventory", () => {
    expect(parsePets({ KubrowPets: [CUAN] })).toEqual([
      {
        id: "6aaec1b8e3bd0e40510f69a6",
        type: CUAN.ItemType,
        name: "/SF/Language/Quests/OrengallPupName3",
        temperament: "TEMPERMENT_PLAYFUL",
        adult: false,
        skills: { Guard: 3, Speed: 2, Stamina: 2, Search: 3, Support: 1 },
        xp: { Guard: 4214, Speed: 3192, Stamina: 2820, Search: 4668, Support: 625 },
        bond: 6215,
        needsRest: true,
        restUntil: 1794347873000,
        mealsEaten: 1,
        snacksEaten: 0,
      },
    ]);
    expect(parsePets({})).toEqual([]);
  });

  it("takes the pup's words and limits from the game files", () => {
    const dict = {
      "/SF/Language/Quests/OrengallPupName3": "Cuan",
      "/SF/Language/Pets/PetTemperment_Playful": "Playful",
      "/SF/Language/Pets/PetTemperment_Curious": "Clever",
      "/SF/Language/Pets/PetStat_Guard": "Guts",
      "/SF/Language/Pets/PetStat_Stamina": "Endurance",
      "/SF/Language/Pets/PetStat_Maturity": "Training",
      "/SF/Language/Pets/PetStat_MaxMaturity": "Training Complete",
    };
    const texts = [
      "AdultPetSuit=WolfAdultPetPlayfulPowerSuit\nDefaultPetStats={\nName=/SF/Language/Quests/OrengallPupName3\nTemperment=TEMPERMENT_PLAYFUL\n}",
      "DefaultPetStats={\nEnergy=100\n}\nMaxBond=5\nMaxMaturity=15\nMaxGuardSkill=5\nMaxSpeedSkill=5\nMaxStaminaSkill=5\nMaxSearchSkill=5\nMaxSupportSkill=5\nMaxMealsToBeOverfed=5\nSnackOverfed=5",
    ];
    expect(buildPetText(dict, texts)).toEqual({
      names: { "/SF/Language/Quests/OrengallPupName3": "Cuan" },
      temperaments: { TEMPERMENT_CURIOUS: "Clever", TEMPERMENT_PLAYFUL: "Playful" },
      stats: { Guard: "Guts", Stamina: "Endurance" },
      labels: { training: "Training", trainingComplete: "Training Complete" },
      limits: { training: 15, skill: 5, meals: 5, snacks: 5 },
    });
  });

  describe("reaching the dashboard", () => {
    let dir: string | undefined;
    let home: string | undefined;
    beforeAll(async () => {
      dir = process.env.SFHELPER_DATA_DIR;
      home = process.env.SFHELPER_HOME;
      process.env.SFHELPER_DATA_DIR = await mkdtemp(join(tmpdir(), "sfh-names-"));
      process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-home-"));
      await writeFile(
        join(process.env.SFHELPER_DATA_DIR, "names.json"),
        JSON.stringify({ items: { WolfSoul: "Orengal" }, tokenLimits: { FeySyndicate: 50 }, pets: { stats: { Guard: "Guts" } } }),
      );
    });
    afterAll(() => {
      for (const [k, v] of [["SFHELPER_DATA_DIR", dir], ["SFHELPER_HOME", home]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it("keeps the pup text and the Enclave Favour limits in names.json", async () => {
      const names = await getNames();
      expect(names.tokenLimits).toEqual({ FeySyndicate: 50 });
      expect(names.pets).toEqual({ stats: { Guard: "Guts" } });
      expect(names.items.WolfSoul).toBe("Orengal");
    });
  });
});
