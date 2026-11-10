import { describe, expect, it } from "vitest";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectorRegion } from "../src/server/collector";
import { loggedBlessed, loggedCollector, type LoggedCollector } from "../src/server/gameLog";
import { blessedMeetingNear, withCollector, type GameTimer } from "../src/server/timers";

const HEADER = "0.043 Sys [Diag]: Current time: Mon Nov 02 22:00:00 2026 [UTC: Tue Nov 03 03:00:00 2026]";
const START = Date.UTC(2026, 10, 3, 3, 0, 0);
const PRIMED = "1177.731 AI [Info]: ENCMGR: PrimeMissionOnHint [/Layer0/Layer181/CollectorEncounterHint18] at pos [(880.326, -54.9589, -28.7015, 0)] missionTag MT_COLLECTOR";

describe("Collector arrivals", () => {
  it("places each docking site in its region", () => {
    expect(collectorRegion(880.326, -28.7015)).toBe("Fortress O'Dell");
    expect(collectorRegion(1000, 740)).toBe("Fuirlands");
    expect(collectorRegion(210, -1300)).toBe("Kearnhold Lowlands");
    expect(collectorRegion(-600, 200)).toBeNull();
  });

  it("follows one from docking to leaving in the game log", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(log, [HEADER, PRIMED, "1177.731 Script [Info]: CollectorShipObjective.lua: OnPrimed: Collector primed", ""].join("\n"));
    const docked = await loggedCollector(log);
    expect(docked).toMatchObject({ at: START + 1_177_731, x: 880.326, z: -28.7015, started: null, ended: null });

    await writeFile(
      log,
      [HEADER, PRIMED, "1607.623 Script [Info]: CollectorShipObjective.lua: Collector encounter started", "1746.799 Script [Info]: CollectorShipObjective.lua: Collector encounter ending...", ""].join("\n"),
    );
    expect(await loggedCollector(log)).toMatchObject({ started: START + 1_607_623, ended: START + 1_746_799 });
  });

  it("follows the 2026-11-09 game build's log, where the fight starting also ends the waiting loop", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    const lines = [
      HEADER,
      "105.230 Script [Info]: CollectorShipObjective.lua: OnPrimed: Collector primed",
      "105.230 AI [Info]: ENCMGR: PrimeMissionOnHint primed [/Layer0/Layer181/CollectorEncounterHint15] at pos [(124.444, -82.7431, -1258.14, 0)] missionTag MT_COLLECTOR",
      "162.993 Script [Info]: CollectorShipObjective.lua: Collector encounter started",
      "164.028 Script [Info]: CollectorShipObjective.lua: OnPrimed Loop ended",
    ];
    await writeFile(log, [...lines, ""].join("\n"));
    expect(await loggedCollector(log)).toMatchObject({ at: START + 105_230, x: 124.444, z: -1258.14, started: START + 162_993, ended: null });
    expect(collectorRegion(124.444, -1258.14)).toBe("Kearnhold Lowlands");

    await writeFile(
      log,
      [
        ...lines,
        "1205.504 Script [Info]: CollectorShipObjective.lua: PrimedMissionShouldShutDown: No players in encounter radius",
        "1205.504 Script [Info]: CollectorShipObjective.lua: Collector encounter ending...",
        "1215.513 Script [Info]: CollectorShipObjective.lua: Collector encounter ended",
        "",
      ].join("\n"),
    );
    expect(await loggedCollector(log)).toMatchObject({ started: START + 162_993, ended: START + 1_205_504 });
  });

  it("still sees a docking when the game logs no position for it", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(log, [HEADER, "105.230 Script [Info]: CollectorShipObjective.lua: OnPrimed: Collector primed", ""].join("\n"));
    const c = await loggedCollector(log);
    expect(c).toMatchObject({ at: START + 105_230, x: null, z: null, started: null, ended: null });
    expect(withCollector([], { ...c!, logAt: START + 200_000 }, START + 200_000)[0]?.docked).toMatchObject({ region: null, leaves: START + 105_230 + 15 * 60_000 });
  });

  it("ends when players leave before the fight or the area streams out", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    for (const gone of ["OnPrimed: Players left the area, cleaned up all objects", "Shutdown due to streaming (Waited for boss dialog)"]) {
      await writeFile(log, [HEADER, PRIMED, `1300.000 Script [Info]: CollectorShipObjective.lua: ${gone}`, ""].join("\n"));
      expect(await loggedCollector(log)).toMatchObject({ ended: START + 1_300_000 });
    }
  });

  it("shows a docked Collector on the Collector Event row while the game is running", () => {
    const now = START + 1_200_000;
    const spawn = { at: START + 1_177_731, x: 880.326, z: -28.7015, started: null, ended: null, logAt: now - 5_000 };
    const cooldown: GameTimer = { tag: "CollectorTimer", kind: "Operation cooldown", name: "Collector Event", ready: "", expiry: 0 };
    const agari: GameTimer = { tag: "X-SubBoss", kind: "Agari respawn", name: "X", ready: "", expiry: now + 60_000 };

    const shown = withCollector([agari, cooldown], spawn, now);
    expect(shown.map((t) => t.tag)).toEqual(["CollectorTimer", "X-SubBoss"]);
    expect(shown[0]!.docked).toEqual({ at: spawn.at, region: "Fortress O'Dell", started: null, leaves: spawn.at + 15 * 60_000 });
    expect(withCollector([agari], spawn, now)[0]).toMatchObject({ tag: "CollectorTimer", name: "Collector Event" });

    expect(withCollector([agari], { ...spawn, ended: now - 1_000 }, now)).toEqual([agari]);
    expect(withCollector([agari], { ...spawn, logAt: now - 11 * 60_000 }, now)).toEqual([agari]);
    expect(withCollector([agari], null, now)).toEqual([agari]);
  });

  it("ends when it leaves without a fight", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(
      log,
      [
        HEADER,
        PRIMED,
        "1177.732 Script [Info]: CollectorShipObjective.lua: OnPrimed: Collector primed",
        "2078.902 Script [Info]: CollectorShipObjective.lua: OnPrimed Loop ended",
        "2078.902 Script [Info]: CollectorShipObjective.lua: OnPrimed: hint was unprimed and never activated",
        "2078.902 Sys [Info]: Cinematic /Layer0/Layer21/SFCinematic36 Start, 1 scene(s), first: /SF/Animations/Cinematics/Dendria/CollectorLeaving_cin.fbx",
        "2078.903 Script [Info]: CollectorShipObjective.lua: Shutdown collector",
        "",
      ].join("\n"),
    );
    expect(await loggedCollector(log)).toMatchObject({ started: null, ended: START + 2_078_902 });
  });

  it("stays 15 minutes unless the fight starts", () => {
    const at = START + 1_177_731;
    const spawn: LoggedCollector = { at, x: 880.326, z: -28.7015, started: null, ended: null, logAt: 0 };
    const shownAt = (now: number, c = spawn) => withCollector([], { ...c, logAt: now }, now)[0]?.docked ?? null;

    expect(shownAt(at + 14 * 60_000)).toMatchObject({ leaves: at + 15 * 60_000 });
    expect(shownAt(at + 15 * 60_000)).toBeNull();

    const fought = { ...spawn, started: at + 5 * 60_000 };
    expect(shownAt(at + 20 * 60_000, fought)).toMatchObject({ started: at + 5 * 60_000, leaves: null });
    expect(shownAt(at + 36 * 60_000, fought)).toBeNull();
  });
});

describe("Blessed Meetings near the Envoy", () => {
  const BLESSED = "/SF/Types/Game/Encounters/Ambient/Dynamic/DynamicGodsAndGhostEncounter";
  const started = (t: string) => `${t} AI [Info]: ENCMGR: Encounter ${BLESSED} started at /DynamicRandomEncounterHint1338 at pos [(-215.329, -51.65, -455.594, 0)]`;
  const completed = (t: string) => `${t} AI [Info]: ENCMGR: Encounter [${BLESSED}] has completed on hint [/DynamicRandomEncounterHint1338] at pos [(-215.329, -51.65, -455.594, 0)] status ES_NONE`;
  const write = async (lines: string[]) => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(log, [HEADER, ...lines, ""].join("\n"));
    return log;
  };

  it("sees one start and end in the game log", async () => {
    const log = await write([
      `6544.1 AI [Info]: Hint /Layer0/Layer180/DungeonEntranceHintGlades1, (pre-vetted) GlobalTags, and DynamicContainers are missing tags required by Encounter ${BLESSED}: No valid EnvironmentTags.`,
      started("632.470"),
    ]);
    expect(await loggedBlessed(log)).toMatchObject({ at: START + 632_470, ended: null });

    const done = await write([started("632.470"), "700.000 Script [Info]: GodsAndGhostEncounter.lua: GodsAndGhostENC: is shutting down to no players in range or expiry timer is set", completed("700.010")]);
    expect(await loggedBlessed(done)).toMatchObject({ at: START + 632_470, ended: START + 700_000 });
  });

  it("ignores one that gives up because today's boon was already taken", async () => {
    const log = await write([
      "632.470 Script [Info]: GodsAndGhostEncounter.lua: GodsAndGhostENC: Ending early due to boon timer being active",
      "632.470 Script [Info]: GodsAndGhostEncounter.lua: GodsAndGhostENC: start up failed, shutting down encounter",
      started("632.470"),
      completed("632.484"),
    ]);
    const b = await loggedBlessed(log);
    expect(b).toMatchObject({ at: START + 632_470, ended: START + 632_470 });
    expect(blessedMeetingNear(b, START + 640_000)).toBe(false);
  });

  it("notifies only for a fresh one that's still running", () => {
    const b = { at: START, ended: null, logAt: START };
    expect(blessedMeetingNear(b, START + 500)).toBe(false);
    expect(blessedMeetingNear(b, START + 10_000)).toBe(true);
    expect(blessedMeetingNear(b, START + 6 * 60_000)).toBe(false);
    expect(blessedMeetingNear({ ...b, ended: START + 5_000 }, START + 10_000)).toBe(false);
    expect(blessedMeetingNear(null, START)).toBe(false);
  });
});
