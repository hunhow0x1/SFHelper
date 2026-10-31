import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateEnvoyRank, itemMastery, rankStart } from "../src/server/envoyRank";
import { loggedMastery } from "../src/server/gameLog";
import { parseMaxMastery } from "../scripts/build_data";

const W = (n: number) => `/SF/Weapons/Melee/W${n}`;
const P = (n: number) => `/SF/Souls/P${n}/P${n}Soul`;
const XP30 = 450_000;

describe("Envoy Rank", () => {
  it("reads the patch maximum from the wiki's wording", () => {
    expect(parseMaxMastery("'''Maximum Mastery''' as of {{VerShort|P16}} is ~'''19.1''' for [[Paragon Founders]].")).toEqual({
      maxMastery: 19.1,
      patch: "P16",
    });
    expect(parseMaxMastery("no figure here")).toBeNull();
  });

  it("counts 100 Mastery per weapon rank and 200 per pact rank, capped at 30", () => {
    expect(itemMastery({ [W(1)]: 2_000_000, [W(2)]: 250 * 10 * 10, [P(1)]: XP30, "/SF/Other/X": 9e9 })).toEqual({
      weaponRanks: 40,
      pactRanks: 30,
      xp: 40 * 100 + 30 * 200,
    });
  });

  it("ranks weapons at 250 * r^2 and pacts at 500 * r^2", () => {
    // A Paragon at 232,074 XP is rank 30 in game; a pact needs twice that.
    expect(itemMastery({ [W(1)]: 232_074 })).toMatchObject({ weaponRanks: 30 });
    expect(itemMastery({ [P(1)]: 232_074 })).toMatchObject({ pactRanks: 21 });
    expect(itemMastery({ [W(1)]: 224_999 })).toMatchObject({ weaponRanks: 29 });
  });

  const base = { weaponCount: 62, pactCount: 13, maxMastery: 19.1, patch: "P16" };
  // The account the formula was checked on: 1,234 weapon ranks, 360 pact ranks
  // (the game logged 195,400) and 180,000 MissionProgressXP, badge a third full.
  const checked = Object.fromEntries([
    ...Array.from({ length: 41 }, (_, i) => [W(i), XP30]),
    [W(41), 250 * 4 * 4],
    ...Array.from({ length: 12 }, (_, i) => [P(i), XP30]),
  ]);

  it("matches the game's figures for a rank-17 account", () => {
    expect(itemMastery(checked)).toMatchObject({ weaponRanks: 1234, pactRanks: 360, xp: 195_400 });
    const r = estimateEnvoyRank({ ...base, rank: 17, mastery: checked, other: 180_000 });
    expect(r.mastery).toEqual({ total: 375_400, items: 195_400, other: 180_000, next: rankStart(18) });
    expect(rankStart(17)).toBe(361_250);
    expect(r.progress).toBeCloseTo(0.323, 3);
    expect(r.maxRank).toBe(19);
  });

  it("shows no progress without the log's part, below the rank's start, or at the top rank", () => {
    expect(estimateEnvoyRank({ ...base, rank: 17, mastery: checked }).progress).toBeNull();
    expect(estimateEnvoyRank({ ...base, rank: 17, mastery: checked }).mastery).toBeNull();
    expect(estimateEnvoyRank({ ...base, rank: 17, mastery: checked, other: 100_000 }).progress).toBeNull();
    expect(estimateEnvoyRank({ ...base, rank: 16, mastery: checked, other: 180_000 }).progress).toBe(0.99);
    expect(estimateEnvoyRank({ ...base, rank: 19, mastery: checked, other: 180_000 }).progress).toBeNull();
  });

  it("reads the latest Mastery figures from the game log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sfh-mastery-"));
    const log = join(dir, "EE.log");
    await writeFile(
      log,
      [
        "0.041 Sys [Diag]: Current time: Sat Oct 31 08:43:53 2026 [UTC: Sat Oct 31 12:43:53 2026]",
        "23.329 Sys [Info]: Player has 0 (item based) XP",
        "32.680 Sys [Warning]: Total calculated MissionProgressXP is 175000!",
        "32.762 Sys [Info]: Player has 195400 (item based) XP",
        "57.039 Sys [Warning]: Total calculated MissionProgressXP is 180000!",
        "",
      ].join("\n"),
    );
    expect(await loggedMastery(log)).toEqual({ other: 180_000, items: 195_400 });
    await writeFile(log, "0.041 Sys [Diag]: nothing about Mastery yet\n");
    expect(await loggedMastery(log)).toBeNull();
  });
});
