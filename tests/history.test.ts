import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportHistory, historyFileName, importHistory } from "../src/server/history";
import { pickupHistory } from "../src/server/pickups";
import { tradeHistory } from "../src/server/trades";
import { rememberedAgari, resetRememberedAgari } from "../src/server/timers";

const BOW = "/SF/Weapons/Ranged/TwoHand/OdeBow/OdeBowRangedMeleeWeapon";

const pickup = (id: string, at: string, extra?: Record<string, unknown>) => ({
  id,
  key: BOW,
  craftwork: "IQ_WORN",
  tempers: ["OdeVoltaicDamageMod"],
  xp: 1200,
  moonsteel: false,
  at,
  source: "pickup",
  when: at,
  whenSource: "log",
  ...(extra ? { extra } : {}),
});

const trade = (at: string, partner: string | null = "Envoy1") => ({
  at,
  after: at,
  count: 1,
  received: [{ key: "/SF/Types/PickUps/Resources/Ingots/Catalysts/CatalystBResourceItem", count: 45 }],
  given: [{ key: BOW, count: 1, ids: ["6ae67e02722e7ec1120d88b1"], weapon: { craftwork: null, tempers: [], moonsteel: true } }],
  dracs: -83_600,
  deals: [{ when: at, partner, offered: ["Rhapsodic Chordstone"], received: ["Bow"] }],
});

async function newInstall(): Promise<string> {
  process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-history-"));
  resetRememberedAgari();
  return process.env.SFHELPER_HOME;
}

describe("exporting and importing history", () => {
  let home: string | undefined;
  beforeEach(() => {
    home = process.env.SFHELPER_HOME;
  });
  afterEach(() => {
    if (home === undefined) delete process.env.SFHELPER_HOME;
    else process.env.SFHELPER_HOME = home;
    resetRememberedAgari();
  });

  it("moves pickups, trades and Agari names to a new install", async () => {
    const old = await newInstall();
    await writeFile(
      join(old, "pickups.json"),
      JSON.stringify({
        seeded: true,
        known: {},
        history: [pickup("6ae67e02722e7ec1120d88b2", "2026-11-02T10:00:00.000Z", { Creator: "SomeoneElse" }), pickup("6ae67e02722e7ec1120d88b0", "2026-10-31T23:48:22.659Z")],
      }),
    );
    await writeFile(join(old, "trades.json"), JSON.stringify({ last: { at: "x", holdings: {} }, history: [trade("2026-10-27T02:56:37.173Z")] }));
    await rememberedAgari({ GalvinarCorruptedB: "MendicantKnightBellCleaverSubBossAgent" });

    const file = await exportHistory(new Date("2026-11-04T21:00:00Z"));
    expect(historyFileName(new Date("2026-11-04T21:00:00Z"))).toBe("sfhelper-history-2026-11-04.json");
    expect(file).toMatchObject({ app: "SFHelper", kind: "history", version: 1, exportedAt: "2026-11-04T21:00:00.000Z" });
    expect(file.pickups).toHaveLength(2);
    expect(JSON.stringify(file)).not.toContain("SomeoneElse");
    expect(file.agari).toEqual({ GalvinarCorruptedB: "MendicantKnightBellCleaverSubBossAgent" });

    const fresh = await newInstall();
    const roundTrip = JSON.parse(JSON.stringify(file)) as unknown;
    expect(await importHistory(roundTrip)).toEqual({ pickups: 2, trades: 1, agari: 1, skipped: 0 });
    expect((await pickupHistory()).map((p) => p.id)).toEqual(["6ae67e02722e7ec1120d88b2", "6ae67e02722e7ec1120d88b0"]);
    expect(await tradeHistory()).toEqual(file.trades);
    const saved = JSON.parse(await readFile(join(fresh, "pickups.json"), "utf8")) as { seeded: boolean; known: Record<string, true> };
    expect(saved.seeded).toBe(false);
    expect(Object.keys(saved.known).sort()).toEqual(["6ae67e02722e7ec1120d88b0", "6ae67e02722e7ec1120d88b2"]);
    resetRememberedAgari();
    expect(await rememberedAgari({})).toEqual({ GalvinarCorruptedB: "MendicantKnightBellCleaverSubBossAgent" });

    expect(await importHistory(roundTrip)).toEqual({ pickups: 0, trades: 0, agari: 0, skipped: 0 });
  });

  it("merges with what's already there, newest first", async () => {
    const dir = await newInstall();
    await writeFile(join(dir, "pickups.json"), JSON.stringify({ seeded: true, known: {}, history: [pickup("6ae67e02722e7ec1120d88b5", "2026-11-03T12:00:00.000Z")] }));
    await writeFile(join(dir, "trades.json"), JSON.stringify({ history: [trade("2026-11-03T12:00:00.000Z")] }));

    const result = await importHistory({
      app: "SFHelper",
      kind: "history",
      version: 1,
      pickups: [pickup("6ae67e02722e7ec1120d88b5", "2026-11-03T12:00:00.000Z"), pickup("6ae67e02722e7ec1120d88b6", "2026-11-04T08:00:00.000Z"), pickup("6ae67e02722e7ec1120d88b7", "2026-11-01T08:00:00.000Z")],
      trades: [trade("2026-11-03T12:00:00.000Z"), trade("2026-11-01T09:00:00.000Z", null)],
    });
    expect(result).toEqual({ pickups: 2, trades: 1, agari: 0, skipped: 0 });
    expect((await pickupHistory()).map((p) => p.at)).toEqual(["2026-11-04T08:00:00.000Z", "2026-11-03T12:00:00.000Z", "2026-11-01T08:00:00.000Z"]);
    expect((await tradeHistory()).map((t) => t.at)).toEqual(["2026-11-03T12:00:00.000Z", "2026-11-01T09:00:00.000Z"]);
  });

  it("turns away other files and skips entries it can't trust", async () => {
    await newInstall();
    await expect(importHistory({ history: [] })).rejects.toThrow("That isn't an SFHelper history file.");
    await expect(importHistory({ app: "SFHelper", kind: "history", version: 2 })).rejects.toThrow("newer SFHelper");

    const result = await importHistory({
      app: "SFHelper",
      kind: "history",
      version: 1,
      pickups: [
        pickup("6ae67e02722e7ec1120d88b8", "2026-11-04T08:00:00.000Z"),
        { ...pickup("6ae67e02722e7ec1120d88b9", "2026-11-04T08:00:00.000Z"), key: "<img src=x onerror=alert(1)>" },
        { ...pickup("not-an-id", "2026-11-04T08:00:00.000Z") },
        { ...pickup("6ae67e02722e7ec1120d88ba", "yesterday") },
      ],
      trades: [{ ...trade("2026-11-04T08:00:00.000Z"), deals: [{ when: "2026-11-04T08:00:00.000Z", partner: { name: "x" }, offered: [], received: [] }] }, "junk"],
      agari: {
        StoneHengeA: "RangedHunterBowSubBossAgent",
        "Dungeon-NeathPortal-C-Digsite": "Neathuns/SpiderSubBossProcAgent",
        "<b>": "SpiderSubBossAgent",
        SlaneCenoteCave: "<script>",
        DungeonX: "../SpiderSubBossAgent",
      },
    });
    expect(result).toEqual({ pickups: 1, trades: 0, agari: 2, skipped: 5 });
    expect(await rememberedAgari({})).toEqual({ StoneHengeA: "RangedHunterBowSubBossAgent", "Dungeon-NeathPortal-C-Digsite": "Neathuns/SpiderSubBossProcAgent" });
  });
});
