import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, TEMPER_PLAN_SLOTS, updateSettings } from "../src/server/settings";
import { finishedPlans, planComplete, removeFinishedPlans } from "../src/server/temperPlans";

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

describe("removing a plan once a strike completes it", () => {
  const id = "6af1e520becb4458760fa381";
  const w = (...tempers: string[]) => ({ craftwork: "IQ_LEGENDARY", tempers, moonsteel: false });

  it("counts a plan done when every planned Temper is on the weapon, twice for one planned twice", () => {
    expect(planComplete(["CritChanceMod", null, "CritChanceMod"], ["CritChanceMod", "AttackSpeedMod", "CritChanceMod"])).toBe(true);
    expect(planComplete(["CritChanceMod", "CritChanceMod"], ["CritChanceMod", "AttackSpeedMod"])).toBe(false);
    expect(planComplete([null, null], ["CritChanceMod"])).toBe(false);
  });

  it("only removes plans that the latest strike finished", () => {
    const plans = { [id]: ["CritChanceMod", "AttackSpeedMod"], "6af1e520becb4458760fa382": ["CritChanceMod"] };
    const before = { [id]: w("CritChanceMod"), "6af1e520becb4458760fa382": w("CritChanceMod") };
    const after = { [id]: w("CritChanceMod", "AttackSpeedMod"), "6af1e520becb4458760fa382": w("CritChanceMod") };
    expect(finishedPlans(plans, before, after)).toEqual([id]);
    expect(finishedPlans(plans, after, after)).toEqual([]);
  });

  it("is off until switched on", async () => {
    const home = process.env.SFHELPER_HOME;
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-plans-"));
    try {
      await updateSettings({ temperPlans: { [id]: ["CritChanceMod"] } });
      expect(await removeFinishedPlans({ [id]: w() }, { [id]: w("CritChanceMod") })).toEqual([]);
      await updateSettings({ temperPlanAutoRemove: true });
      expect(await removeFinishedPlans({ [id]: w() }, { [id]: w("CritChanceMod") })).toEqual([id]);
      expect((await getSettings()).temperPlans).toEqual({});
    } finally {
      if (home === undefined) delete process.env.SFHELPER_HOME;
      else process.env.SFHELPER_HOME = home;
    }
  });
});
