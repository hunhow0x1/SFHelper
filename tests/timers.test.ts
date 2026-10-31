import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nameAgari, parseTimers, timerLabel } from "../src/server/timers";
import { loggedAgari } from "../src/server/gameLog";
import { agentName } from "../src/server/enemies";

describe("the game's timers", () => {
  // As in a real inventory: two quest flags long past, two running timers.
  const raw = {
    ExpiryTimeTrackers: [
      { Tag: "OrengallQuest", ExpiryTime: 1764392208, AutoExpire: false },
      { Tag: "UPGRADEGIVEN_GODANDGHOST", ExpiryTime: 1793493613, AutoExpire: true },
      { Tag: "StoneHengeA-SubBoss", ExpiryTime: 1793452725, AutoExpire: true },
      { Tag: "FencerDuelSwordDecoNorth", ExpiryTime: 1776485031, AutoExpire: false },
    ],
  };

  it("keeps only the self-expiring ones, soonest first, in ms", () => {
    expect(parseTimers(raw)).toEqual([
      { tag: "StoneHengeA-SubBoss", kind: "Agari respawn", name: "Stone Henge A", ready: "The Agari at Stone Henge A can return", spot: "StoneHengeA", expiry: 1793452725000 },
      { tag: "UPGRADEGIVEN_GODANDGHOST", kind: "Once a day, after a boon", name: "Blessed Meeting", ready: "Blessed Meetings can happen again", expiry: 1793493613000 },
    ]);
    expect(parseTimers({})).toEqual([]);
  });

  it("names unknown tags from their words", () => {
    expect(timerLabel("SiegeKearnholdCastle")).toEqual({ kind: null, name: "Siege Kearnhold Castle", ready: "Siege Kearnhold Castle is over" });
    expect(timerLabel("VadagarStag-SubBoss")).toMatchObject({ kind: "Agari respawn", name: "Vadagar Stag", spot: "VadagarStag" });
  });

  it("names an Agari timer after the Agari that spawned at its spot", async () => {
    // Shaped like the real EE.log lines for two kills on 2026-10-31.
    const dir = await mkdtemp(join(tmpdir(), "sfh-agari-"));
    const log = join(dir, "EE.log");
    await writeFile(
      log,
      [
        "224.019 Script [Info]: SubBossEncounter.lua: [CombatEncounterHint0-StoneHengeA] Sub-boss encounter starting",
        "224.020 Script [Info]: SubBossEncounter.lua: [CombatEncounterHint0-StoneHengeA] Spawning sub-boss",
        "224.022 AI [Info]: OnAgentCreated /Npc/RangedHunterBowSubBossAgent52 Live 24 Spawned 36 Ticking 24",
        "5133.413 Script [Info]: SubBossEncounter.lua: [CorruptedSwampCombatEncounterHint0-GalvinarCorruptedB] Spawning sub-boss",
        "5133.415 AI [Info]: OnAgentCreated /Npc/MendicantKnightBellCleaverSubBossAgent266 Live 4 Spawned 174",
        "5133.453 AI [Info]: OnAgentCreated /Npc/MendicantWazzardKnightAgent267 Live 5 Spawned 175",
        "876.134 Script [Info]: SubBossEncounter.lua: [CampEncounterMediumHint0-MirifuirSiegeCistern] Spawning sub-boss",
        "876.135 AI [Info]: OnAgentCreated /Npc/MeleeHeavyNightAlwaysAgent153 Live 23 Spawned 98",
        "",
      ].join("\n"),
    );
    const spawned = await loggedAgari(log);
    expect(spawned).toEqual({
      StoneHengeA: "RangedHunterBowSubBossAgent",
      GalvinarCorruptedB: "MendicantKnightBellCleaverSubBossAgent",
      MirifuirSiegeCistern: "MeleeHeavyNightAlwaysAgent",
    });

    // Agents and avatars are named differently; the best word match wins, and
    // a sub-boss agent never takes an ordinary enemy's name.
    const enemies = {
      names: { rangedhuntersubbossavatar: "Gruulseeker Ruthos", rangedhunteravatar: "Sinecure Hunter", mendicantknightbellcleaversubbossavatar: "Knell Knight" },
      parents: { RangedHunterSubBossAvatar: "RangedHunterAvatar", RangedHunterAvatar: "GruntAvatarBase", MendicantKnightBellCleaverSubBossAvatar: "GruntAvatarBase" },
    };
    expect(agentName("RangedHunterBowSubBossAgent", enemies)).toBe("Gruulseeker Ruthos");
    expect(agentName("RangedHunterBowAgent", enemies)).toBe("Sinecure Hunter");
    expect(agentName("SpiderSubBossAgent", enemies)).toBeNull();

    const named = nameAgari(
      parseTimers({
        ExpiryTimeTrackers: [
          { Tag: "GalvinarCorruptedB-SubBoss", ExpiryTime: 1793460000, AutoExpire: true },
          { Tag: "ElsewhereA-SubBoss", ExpiryTime: 1793460100, AutoExpire: true },
          { Tag: "MirifuirSiegeCistern-SubBoss", ExpiryTime: 1793460200, AutoExpire: true },
        ],
      }),
      spawned,
      (a) => agentName(a, enemies),
    );
    expect(named.map((t) => [t.name, t.ready])).toEqual([
      ["Knell Knight", "Knell Knight can return"],
      ["Elsewhere A", "The Agari at Elsewhere A can return"], // not in this session's log
      ["Mirifuir Siege Cistern", "The Agari at Mirifuir Siege Cistern can return"], // an ordinary enemy type
    ]);
  });
});
