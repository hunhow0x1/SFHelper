import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameRefusals, loggedAgari, loggedMastery, loggedTradeOpened, logTrades } from "../src/server/gameLog";

const HEADER = "0.043 Sys [Diag]: Current time: Sat Oct 31 13:00:03 2026 [UTC: Sat Oct 31 17:00:03 2026]\n";
const START = Date.UTC(2026, 9, 31, 17, 0, 3);

describe("reading the game log as it grows", () => {
  it("picks up new lines, waits for an unfinished one, and starts over for a new session", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(log, `${HEADER}10.000 Sys [Info]: Player has 195400 (item based) XP\n`);
    expect(await loggedMastery(log)).toBeNull();

    await appendFile(log, "11.000 Sys [Info]: Total calculated MissionProgressXP is 180000\n12.000 Script [Info]: SubBossEncounter.lua: [Hint0-StoneHengeA] Spawning sub-boss\n12.001 AI [Info]: OnAgentCreated /Npc/RangedHunterBowSub");
    expect(await loggedMastery(log)).toEqual({ other: 180000, items: 195400 });
    expect(await loggedAgari(log)).toEqual({});

    await appendFile(log, "BossAgent52 Live 24\n");
    expect(await loggedAgari(log)).toEqual({ StoneHengeA: "RangedHunterBowSubBossAgent" });

    await writeFile(log, `${HEADER.replace("13:00:03", "14:00:03").replace("17:00:03", "18:00:03")}1.000 Sys [Info]: nothing yet\n`);
    expect(await loggedMastery(log)).toBeNull();
    expect(await loggedAgari(log)).toEqual({});
  });

  it("finds a trade spread over several lines", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(
      log,
      [
        HEADER.trimEnd(),
        "95.250 Sys [Info]: Created /SF/Interface/Trade.swf",
        "98.100 Input [Info]: Subscribing for /SF/Interface/Trade.swf with input filter /EE/Types/Input/MenuInputFilter",
        "100.000 Script [Info]: Dialog::Create: You are offering:",
        "Rhapsodic Chordstone x2",
        "and will receive from Envoy1 the following:",
        "Faer Lampyrite x50, leftItem=",
        "101.500 Script [Info]: Dialog::Create: description=The trade was successful!",
        "102.000 Net [Info]: HTTP/1.1 429 Too Many Requests",
        "",
      ].join("\n"),
    );
    expect(await logTrades(log)).toEqual([
      { at: START + 101_500, partner: "Envoy1", offered: ["Rhapsodic Chordstone x2"], received: ["Faer Lampyrite x50"] },
    ]);
    expect(await gameRefusals(log)).toEqual({ count: 1, first: START + 102_000, last: START + 102_000, loginRefused: false });
    expect(await loggedTradeOpened(log)).toBe(START + 98_100);
  });
});
