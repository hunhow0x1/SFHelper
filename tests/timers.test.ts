import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dungeonName, mergeAgariSpots, nameAgari, parseTimers, rememberedAgari, resetRememberedAgari, timerLabel, TimerAlarms, withStarred, type GameTimer } from "../src/server/timers";
import { getSettings, updateSettings } from "../src/server/settings";
import { loggedAgari } from "../src/server/gameLog";
import { agentName } from "../src/server/enemies";

describe("the game's timers", () => {
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
    expect(timerLabel("MirifuirSiege")).toEqual({ kind: "Siege cooldown", name: "Mirifuir Siege", ready: "The Mirifuir Siege can start again" });
    expect(timerLabel("PumpkinRider")).toEqual({ kind: "Event boss cooldown", name: "Veltruska", ready: "Veltruska can emerge again" });
    expect(timerLabel("PollutionTowerAirdelands")).toEqual({ kind: "Organ cooldown", name: "Fuirlands Organ", ready: "The Fuirlands Organ can be destroyed again" });
    expect(timerLabel("PollutionTowerODell").name).toBe("O'Dell Organ");
    expect(timerLabel("PollutionTowerOdell").name).toBe("O'Dell Organ");
    expect(timerLabel("CollectorTimer")).toEqual({ kind: "Operation cooldown", name: "Collector Event", ready: "The Collector Event can happen again" });
    expect(timerLabel("PollutionTowerKearnhold").name).toBe("Kearnhold Lowlands Organ");
    expect(timerLabel("PollutionTowerNewRegion").name).toBe("New Region Organ");
    expect(timerLabel("VadagarStag-SubBoss")).toMatchObject({ kind: "Agari respawn", name: "Vadagar Stag", spot: "VadagarStag" });
  });

  it("names an Agari timer after the Agari that spawned at its spot", async () => {
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
      ["Elsewhere A", "The Agari at Elsewhere A can return"],
      ["Mirifuir Siege Cistern", "The Agari at Mirifuir Siege Cistern can return"],
    ]);
  });

  describe("across restarts", () => {
    let home: string | undefined;
    beforeEach(async () => {
      home = process.env.SFHELPER_HOME;
      process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-timers-"));
      resetRememberedAgari();
    });
    afterEach(() => {
      if (home === undefined) delete process.env.SFHELPER_HOME;
      else process.env.SFHELPER_HOME = home;
      resetRememberedAgari();
    });

    it("keeps an Agari's spawn after the game starts a new log", async () => {
      await rememberedAgari({ GalvinarCorruptedB: "MendicantKnightBellCleaverSubBossAgent" });
      resetRememberedAgari();
      expect(await rememberedAgari({ StoneHengeA: "RangedHunterBowSubBossAgent" })).toEqual({
        GalvinarCorruptedB: "MendicantKnightBellCleaverSubBossAgent",
        StoneHengeA: "RangedHunterBowSubBossAgent",
      });
      expect(JSON.parse(await readFile(join(process.env.SFHELPER_HOME!, "agari.json"), "utf8"))).toMatchObject({
        GalvinarCorruptedB: "MendicantKnightBellCleaverSubBossAgent",
      });
      expect((await rememberedAgari({ StoneHengeA: "SpiderSubBossAgent" })).StoneHengeA).toBe("SpiderSubBossAgent");
    });

    it("saves only valid starred tags", async () => {
      await updateSettings({ timerWatch: ["StoneHengeA-SubBoss", "<img onerror=x>"] });
      expect((await getSettings()).timerWatch).toEqual([]);
      await updateSettings({ timerWatch: ["StoneHengeA-SubBoss", "StoneHengeA-SubBoss", "UPGRADEGIVEN_GODANDGHOST"] });
      expect((await getSettings()).timerWatch).toEqual(["StoneHengeA-SubBoss", "UPGRADEGIVEN_GODANDGHOST"]);
    });
  });

  it("lists a starred timer that isn't running", () => {
    const running = parseTimers(raw);
    const listed = withStarred(running, ["StoneHengeA-SubBoss", "GalvinarCorruptedB-SubBoss"]);
    expect(listed.slice(0, running.length)).toEqual(running);
    expect(listed.slice(running.length)).toEqual([
      { tag: "GalvinarCorruptedB-SubBoss", kind: "Agari respawn", name: "Galvinar Corrupted B", ready: "The Agari at Galvinar Corrupted B can return", spot: "GalvinarCorruptedB", expiry: 0 },
    ]);
  });

  it("raises each alarm once, late after a sleep, and never for one that ended before launch", () => {
    const t = (tag: string, expiry: number, name = tag): GameTimer => ({ tag, kind: null, name, ready: "", expiry });
    const alarms = new TimerAlarms();
    alarms.set([t("Ended", 500), t("A", 1_000), t("B", 5_000)], 900);
    expect(alarms.due(900)).toEqual([]);
    alarms.set([t("A", 1_000, "Knell Knight"), t("B", 5_000)], 950);
    expect(alarms.due(1_000).map((x) => x.name)).toEqual(["Knell Knight"]);
    expect(alarms.due(1_100)).toEqual([]);
    alarms.set([t("B", 5_000)], 4_999);
    alarms.set([], 6_000);
    expect(alarms.due(60_000).map((x) => x.tag)).toEqual(["B"]);
    alarms.set([t("C", 70_000)], 60_000);
    alarms.set([], 61_000);
    expect(alarms.due(80_000)).toEqual([]);
  });

  it("names known Agari on a computer that hasn't seen them spawn", async () => {
    const KNOWN_AGARI = JSON.parse(await readFile("src/server/public/agari-spots.json", "utf8")) as Record<string, string>;
    const enemies = {
      names: {
        mendicantknightbellcleaversubbossavatar: "Knell Knight",
        meleemaceofficersubbossavatar: "Sinecure-Errant Gawth",
        spidersubbossavatar: "Etheldred The Weaver",
        mendicantkingavatar: "Mendicant King",
      },
      parents: { MendicantKnightBellCleaverSubBossAvatar: "GruntAvatarBase", MeleeMaceOfficerSubBossAvatar: "GruntAvatarBase", SpiderSubBossAvatar: "GruntAvatarBase", MendicantKingAvatar: "GruntAvatarBase" },
    };
    const timers = parseTimers({
      ExpiryTimeTrackers: ["GalvinarCorruptedB", "LargeRuinsCamp", "SlaneCenoteCave", "MendicantKingA"].map((spot, i) => ({ Tag: `${spot}-SubBoss`, ExpiryTime: 1793460000 + i, AutoExpire: true })),
    });
    expect(nameAgari(timers, { ...KNOWN_AGARI }, (a) => agentName(a, enemies)).map((t) => t.name)).toEqual([
      "Knell Knight",
      "Sinecure-Errant Gawth",
      "Etheldred The Weaver",
      "Mendicant King - Stroaic",
    ]);
    expect(Object.values(KNOWN_AGARI).every((agent) => /SubBoss|^MendicantKingAgent$/.test(agent))).toBe(true);
    expect(Object.keys(KNOWN_AGARI).some((spot) => spot.startsWith("Dungeon-"))).toBe(false);
  });

  it("adds the Agari spots this computer has learned to the built-in list", () => {
    const learned = {
      PSStoneMockery: "MockeryStoneWomanArmoredSubBossAgent",
      TurretJotarFortFinal: "MeleeAxeAgent",
      StoneHengeA: "RangedHunterBowSubBossAgent",
      MendicantKingA: "MendicantKingAgent",
      "Dungeon-NeathPortal-C-Digsite": "Neathuns/SpiderSubBossProcAgent",
    };
    expect(mergeAgariSpots({ StoneHengeA: "RangedHunterBowSubBossAgent", LargeRuinsCamp: "MeleeMaceOfficerSubBossAgent" }, learned)).toEqual({
      spots: { LargeRuinsCamp: "MeleeMaceOfficerSubBossAgent", MendicantKingA: "MendicantKingAgent", PSStoneMockery: "MockeryStoneWomanArmoredSubBossAgent", StoneHengeA: "RangedHunterBowSubBossAgent" },
      added: ["MendicantKingA", "PSStoneMockery"],
    });
  });

  it("names dungeon Agari and the Mendicant King after where they were fought", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-agari-")), "EE.log");
    await writeFile(
      log,
      [
        "362.554 Script [Info]: LoadTriggers.lua: SetCurrentLocation: NeathPortal-C-Digsite",
        "364.376 Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL /SF/Levels/Procs/Neathuns/NeathunsProcLevelCrossingSubboss",
        "427.169 Script [Info]: SubBossEncounter.lua: [DungeonSubbossHint0-DungeonSubboss] Spawning sub-boss",
        "427.171 AI [Info]: OnAgentCreated /Npc/SpiderSubBossProcAgent55 Live 8 Spawned 46 Ticking 6",
        "427.171 Script [Info]: SubBossEncounter.lua: [DungeonSubbossHint0-DungeonSubboss] Created agent at tagged NpcSpawnPoint",
        "676.896 Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL /SF/Levels/Procs/MidrathProc",
        "1338.946 Script [Info]: SubBossEncounter.lua: [MendicantKingEncounterHint0-MendicantKingA] Spawning sub-boss",
        ...Array.from({ length: 8 }, (_, i) => `${1339 + i}.000 Input [Info]: InitMapping for all devices`),
        "1436.600 AI [Info]: OnAgentCreated /Npc/MendicantKnightAgent201 Live 29 Spawned 174",
        "1436.601 AI [Info]: OnAgentCreated /Npc/MendicantKingAgent203 Live 30 Spawned 175 Ticking 26",
        "1436.601 Script [Info]: SubBossEncounter.lua: [MendicantKingEncounterHint0-MendicantKingA] Created agent at tagged entity",
        "1436.700 AI [Info]: OnAgentCreated /Npc/MendicantKnightAgent204 Live 31 Spawned 176",
        "1440.000 Script [Info]: SubBossEncounter.lua: [CampEncounterHint0-KearnholdChapelCamp] Created agent at tagged entity",
        "",
      ].join("\n"),
    );
    const spawned = await loggedAgari(log);
    expect(spawned).toEqual({ "Dungeon-NeathPortal-C-Digsite": "Neathuns/SpiderSubBossProcAgent", MendicantKingA: "MendicantKingAgent" });

    const enemies = {
      names: { spidersubbossprocavatar: "Seachnall The Widower", mendicantkingavatar: "Mendicant King" },
      parents: { SpiderSubBossProcAvatar: "SpiderSubBossAvatar", SpiderSubBossAvatar: "GruntAvatarBase", MendicantKingAvatar: "GruntAvatarBase" },
    };
    const dungeons = { FallenFortress: "Rovgot Ruins", Glades: "Glades of Andurin", MidrathMines: "Carntyne Colliery", Neathuns: "Neath'uns", UnderCity: "Dermak Undercity" };
    const timers = parseTimers({
      ExpiryTimeTrackers: ["Dungeon-NeathPortal-C-Digsite", "MendicantKingA", "Dungeon-SkytowerPortal-A", "Dungeon-Unseen-B"].map((spot, i) => ({ Tag: `${spot}-SubBoss`, ExpiryTime: 1794159498 + i, AutoExpire: true })),
    });
    const named = nameAgari(timers, { ...spawned, "Dungeon-SkytowerPortal-A": "FallenFortress/MendicantKingAgent" }, (a) => agentName(a, enemies), dungeons);
    expect(named.map((t) => [t.name, t.ready])).toEqual([
      ["Seachnall The Widower - Neath'uns", "Seachnall The Widower - Neath'uns can return"],
      ["Mendicant King - Stroaic", "Mendicant King - Stroaic can return"],
      ["Mendicant King - Rovgot Ruins", "Mendicant King - Rovgot Ruins can return"],
      ["Dungeon Unseen B", "The Agari at Dungeon Unseen B can return"],
    ]);
    expect([dungeonName("GladesofAndurin", dungeons), dungeonName("Mines", dungeons), dungeonName("UnderCityMidrath", dungeons), dungeonName("OdeSkyCastle", dungeons)]).toEqual([
      "Glades of Andurin",
      "Carntyne Colliery",
      "Dermak Undercity",
      null,
    ]);
  });
});
