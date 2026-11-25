import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loggedSession, type LoggedSession } from "../src/server/gameLog";
import { lootBetween, parseLoot, playSessions, recordSessionLoot, syncPlaySession, type LootSnapshot } from "../src/server/sessions";

const HEADER = "0.043 Sys [Diag]: Current time: Tue Nov 24 18:03:00 2026 [UTC: Tue Nov 24 22:03:00 2026]";
const START = Date.UTC(2026, 10, 24, 22, 3, 0);
const STEEL = "/SF/Types/PickUps/Resources/ScrapMetals/ScrapSteelResource";
const BELL = "/SF/Types/PickUps/Resources/Organics/Flowers/MourningBellResource";
const BLADE = "/SF/Weapons/Melee/OneHand/BromiusCleaver/BromiusCleaverMeleeWeapon";
const BLUEPRINT = "/SF/Types/Recipes/Weapons/BromiusCleaverMeleeWeaponBlueprint";
const ELIXIR = "/SF/Types/Items/Consumables/HealingPotion";

const snap = (o: Partial<LootSnapshot> = {}): LootSnapshot => ({ counts: {}, instances: {}, xp: {}, pending: {}, purchases: {}, ...o });
const ctx = {
  recipes: { [BLUEPRINT]: { result: BLADE, gives: 1, fragments: 3, consumed: true, ingredients: [{ type: STEEL, count: 15 }] } },
  offers: { "6af620efdfe32177265dd9d9": ELIXIR },
  traded: false,
};

describe("dungeon runs in the game log", () => {
  it("times each stay in a dungeon, ignoring re-entries of the same one, until the game shuts down", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(
      log,
      [
        HEADER,
        "42.857 Script [Info]: MainMenu.lua: MainMenu::LoginDone result=true",
        "43.824 Script [Info]: LoginScripts.lua: STATS ENTER_LEVEL /SF/Levels/Procs/MidrathProc",
        "364.000 Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL /SF/Levels/Procs/FallenFortress/FallenFortressProcLevel",
        "500.000 Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL /SF/Levels/Procs/FallenFortress/FallenFortressProcLevel",
        "1476.000 Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL /SF/Levels/Procs/MidrathProc",
        "1600.000 Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL /SF/Levels/Procs/Neathuns/NeathunsProcLevel",
        "1900.000 Sys [Info]: Main Shutdown Complete.",
        "",
      ].join("\n"),
    );
    expect(await loggedSession(log)).toEqual({
      start: START,
      lastAt: START + 1_900_000,
      loginAt: START + 42_857,
      ended: true,
      runs: [
        { folder: "FallenFortress", level: "FallenFortressProcLevel", start: START + 364_000, end: START + 1_476_000 },
        { folder: "Neathuns", level: "NeathunsProcLevel", start: START + 1_600_000, end: START + 1_900_000 },
      ],
    });
  });
});

describe("what came in between two inventory reads", () => {
  it("reads counted items, item copies, XP, crafts and purchases, leaving out Temper study counts", () => {
    const s = parseLoot({
      MiscItems: [{ ItemType: STEEL, ItemCount: 40 }],
      RawUpgrades: [{ ItemType: "/SF/Types/Items/Aspects/Tempers/CritChanceMod", ItemCount: 7 }],
      Consumables: [{ ItemType: ELIXIR, ItemCount: 8 }],
      Recipes: [{ ItemType: BLUEPRINT, ItemCount: 2 }],
      Melee: [{ ItemType: BLADE, ItemId: { $oid: "6af1e520becb4458760fa381" } }],
      WeaponSkins: [{ ItemType: "/SF/Upgrades/Skins/Hair/Hair01", ItemId: { $oid: "6af1e520becb4458760fa382" } }],
      XPInfo: [{ ItemType: BLADE, XP: 1200 }],
      PendingRecipes: [{ ItemType: BLUEPRINT, ItemId: { $oid: "6af1e520becb4458760fa383" } }],
      RecentVendorPurchases: [{ PurchaseHistory: [{ ItemId: "6af620efdfe32177265dd9d9", NumPurchased: 2 }] }],
    });
    expect(s).toEqual({
      counts: { [STEEL]: 40, [ELIXIR]: 8, [BLUEPRINT]: 2 },
      instances: { "6af1e520becb4458760fa381": BLADE },
      xp: { [BLADE]: 1200 },
      pending: { "6af1e520becb4458760fa383": BLUEPRINT },
      purchases: { "6af620efdfe32177265dd9d9": 2 },
    });
  });

  it("keeps what was picked up, adding back what a new craft used and taking out claimed crafts and purchases", () => {
    const prev = snap({ counts: { [STEEL]: 20, [BLUEPRINT]: 3, [ELIXIR]: 5 }, xp: { [BLADE]: 100 }, pending: { a: BLUEPRINT } });
    const next = snap({
      counts: { [STEEL]: 30, [BLUEPRINT]: 1, [ELIXIR]: 7, [BELL]: 4 },
      instances: { "6af1e520becb4458760fa381": BLADE, "6af1e520becb4458760fa384": BLADE },
      xp: { [BLADE]: 350 },
      pending: { b: BLUEPRINT },
      purchases: { "6af620efdfe32177265dd9d9": 2 },
    });
    expect(lootBetween(prev, next, ctx)).toEqual({
      counts: { [STEEL]: 25, [BLUEPRINT]: 1, [BELL]: 4 },
      items: [{ id: "6af1e520becb4458760fa384", key: BLADE }],
      xp: { [BLADE]: 250 },
    });
  });

  it("adds no items for a read with a trade in it, only XP", () => {
    const prev = snap({ counts: { [STEEL]: 20 }, xp: { [BLADE]: 100 } });
    const next = snap({ counts: { [STEEL]: 80 }, xp: { [BLADE]: 160 } });
    expect(lootBetween(prev, next, { ...ctx, traded: true })).toEqual({ counts: {}, items: [], xp: { [BLADE]: 60 } });
  });
});

describe("play sessions", () => {
  let home: string | undefined;
  beforeEach(async () => {
    home = process.env.SFHELPER_HOME;
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-sessions-"));
  });
  afterEach(() => {
    if (home === undefined) delete process.env.SFHELPER_HOME;
    else process.env.SFHELPER_HOME = home;
  });

  const session = (start: number, o: Partial<LoggedSession> = {}): LoggedSession => ({ start, lastAt: start + 60_000, loginAt: start + 40_000, ended: false, runs: [], ...o });
  const at = (ms: number) => new Date(ms).toISOString();

  it("gives each read's loot to the session it was picked up in, and a read just after login to the session before", async () => {
    const first = session(START);
    await syncPlaySession(first);
    await recordSessionLoot(snap({ counts: { [STEEL]: 10 } }), at(START + 60_000), false, first);
    await recordSessionLoot(snap({ counts: { [STEEL]: 25 } }), at(START + 20 * 60_000), false, first);
    await recordSessionLoot(snap({ counts: { [STEEL]: 25 } }), at(START + 20 * 60_000), false, first);
    await syncPlaySession({ ...first, lastAt: START + 30 * 60_000, ended: true });

    const second = session(START + 3_600_000);
    await syncPlaySession(second);
    await recordSessionLoot(snap({ counts: { [STEEL]: 31 } }), at(second.start + 60_000), false, second);
    await recordSessionLoot(snap({ counts: { [STEEL]: 31, [BELL]: 2 } }), at(second.start + 40 * 60_000), false, second);

    const [newer, older] = await playSessions();
    expect(older).toMatchObject({ id: START, ended: true, end: START + 30 * 60_000, counts: { [STEEL]: 21 }, reads: 2 });
    expect(newer).toMatchObject({ id: START + 3_600_000, ended: false, counts: { [BELL]: 2 }, reads: 1 });
  });
});
