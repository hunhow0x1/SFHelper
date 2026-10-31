import { describe, expect, it } from "vitest";
import { parseTimers, timerLabel } from "../src/server/timers";

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
      { tag: "StoneHengeA-SubBoss", kind: "Agari respawn", name: "Stone Henge A", ready: "The Agari at Stone Henge A can return", expiry: 1793452725000 },
      { tag: "UPGRADEGIVEN_GODANDGHOST", kind: "Once a day, after a boon", name: "Blessed Meeting", ready: "Blessed Meetings can happen again", expiry: 1793493613000 },
    ]);
    expect(parseTimers({})).toEqual([]);
  });

  it("names unknown tags from their words", () => {
    expect(timerLabel("SiegeKearnholdCastle")).toEqual({ kind: null, name: "Siege Kearnhold Castle", ready: "Siege Kearnhold Castle is over" });
    expect(timerLabel("VadagarStag-SubBoss")).toMatchObject({ kind: "Agari respawn", name: "Vadagar Stag" });
  });
});
