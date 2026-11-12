import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, TEMPER_PLAN_SLOTS, updateSettings } from "../src/server/settings";

describe("Temper plans for Legendary weapons", () => {
  let home: string | undefined;
  beforeEach(async () => {
    home = process.env.SFHELPER_HOME;
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-plans-"));
  });
  afterEach(() => {
    if (home === undefined) delete process.env.SFHELPER_HOME;
    else process.env.SFHELPER_HOME = home;
  });

  const id = "6af1e520becb4458760fa381";

  it("saves a plan per weapon, one Temper or an empty slot each", async () => {
    expect((await getSettings()).temperPlans).toEqual({});
    const plan = ["AttackSpeedMod", "AttackSpeedMod", null, "CritChanceMod"];
    await updateSettings({ temperPlans: { [id]: plan, "6af1e520becb4458760fa382": [null, null] } });
    expect((await getSettings()).temperPlans).toEqual({ [id]: plan });
  });

  it("ignores plans that aren't valid", async () => {
    await updateSettings({ temperPlans: { [id]: ["CritChanceMod"] } });
    await updateSettings({ temperPlans: { "not-an-id": ["CritChanceMod"] } });
    await updateSettings({ temperPlans: { [id]: Array(TEMPER_PLAN_SLOTS + 1).fill("CritChanceMod") } });
    await updateSettings({ temperPlans: { [id]: ["<script>"] } });
    expect((await getSettings()).temperPlans).toEqual({ [id]: ["CritChanceMod"] });
  });
});
