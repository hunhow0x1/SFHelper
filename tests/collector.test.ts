import { describe, expect, it } from "vitest";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectorRegion } from "../src/server/collector";
import { loggedCollector } from "../src/server/gameLog";
import { withCollector, type GameTimer } from "../src/server/timers";

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

  it("shows a docked Collector on the Collector Event row while the game is running", () => {
    const now = START + 1_200_000;
    const spawn = { at: START + 1_177_731, x: 880.326, z: -28.7015, started: null, ended: null, logAt: now - 5_000 };
    const cooldown: GameTimer = { tag: "CollectorTimer", kind: "Operation cooldown", name: "Collector Event", ready: "", expiry: 0 };
    const agari: GameTimer = { tag: "X-SubBoss", kind: "Agari respawn", name: "X", ready: "", expiry: now + 60_000 };

    const shown = withCollector([agari, cooldown], spawn, now);
    expect(shown.map((t) => t.tag)).toEqual(["CollectorTimer", "X-SubBoss"]);
    expect(shown[0]!.docked).toEqual({ at: spawn.at, region: "Fortress O'Dell" });
    expect(withCollector([agari], spawn, now)[0]).toMatchObject({ tag: "CollectorTimer", name: "Collector Event" });

    expect(withCollector([agari], { ...spawn, ended: now - 1_000 }, now)).toEqual([agari]);
    expect(withCollector([agari], { ...spawn, logAt: now - 11 * 60_000 }, now)).toEqual([agari]);
    expect(withCollector([agari], null, now)).toEqual([agari]);
  });
});
