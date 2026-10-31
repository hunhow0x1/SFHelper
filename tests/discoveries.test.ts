import { describe, expect, it } from "vitest";
import { discoveries, parseLoreScans } from "../src/server/discoveries";

describe("Discoveries", () => {
  const defs = {
    TowerCampLoreFragment: { name: "College of Pensives", memories: 5, map: false },
    KairnessLocationLoreFragment: { name: "Kairness", memories: 3, map: false },
    RorasHyneLocationLoreFragment: { name: "Othavess", memories: 3, map: false },
    KearnholdCastleLocationLoreFragment: { name: "Castle Kearnhold", memories: 3, map: false },
    UnderCityMillLocationLoreFragment: { name: "Pegroot Mill", memories: 0, map: false },
    UCWellMapLoreFragment: { name: "Dermak Undercity", memories: 0, map: true },
    UCMinesMapLoreFragment: { name: "Dermak Undercity", memories: 0, map: true },
  };
  // Shaped like a real inventory's LoreFragmentScans.
  const raw = {
    LoreFragmentScans: [
      { Progress: 5, Redeemed: true, ItemType: "/SF/Types/Quests/LocationLoreQuests/TowerCampLoreFragment" },
      { Progress: 1, Redeemed: false, ItemType: "/SF/Types/Quests/LocationLoreQuests/KairnessLocationLoreFragment" },
      { Progress: 4, Redeemed: false, ItemType: "/SF/Types/Quests/LocationLoreQuests/RorasHyneLocationLoreFragment" },
      { Progress: 0, Redeemed: false, ItemType: "/SF/Types/Quests/LocationLoreQuests/UnderCityMillLocationLoreFragment" },
      { Progress: 0, Redeemed: false, ItemType: "/SF/Types/Quests/LocationLoreQuests/UCWellMapLoreFragment" },
      { Progress: 2, Redeemed: false, ItemType: "/SF/Types/Lore/CharacterLore/AvakotCharacterLoreFragment" },
    ],
  };

  it("reads location scans only, keyed by type", () => {
    const scans = parseLoreScans(raw);
    expect(Object.keys(scans)).toHaveLength(5);
    expect(scans.TowerCampLoreFragment).toEqual({ progress: 5, redeemed: true });
  });

  it("lists every place by name with Memories found, and counts maps", () => {
    const d = discoveries(parseLoreScans(raw), defs);
    expect(d.places.map((p) => p.name)).toEqual(["Castle Kearnhold", "College of Pensives", "Kairness", "Othavess", "Pegroot Mill"]);
    expect(d.places.find((p) => p.name === "Kairness")).toMatchObject({ found: 1, memories: 3, discovered: true });
    expect(d.places.find((p) => p.name === "Castle Kearnhold")).toMatchObject({ found: 0, discovered: false });
    // More Progress than Memories (seen in game) shows as complete, not over.
    expect(d.places.find((p) => p.name === "Othavess")).toMatchObject({ found: 3, memories: 3 });
    expect(d.maps).toEqual({ found: 1, total: 2 });
  });
});
