import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachDeals, detectTrade, parseHoldings, recordTrades, remainingToday, tradedIds, tradesBetween, type Trade } from "../src/server/trades";
import { onMoonsteelAcquired, recordPickups } from "../src/server/pickups";

const SWORD = "/SF/Weapons/Melee/OneHand/Sword/SwordMeleeWeapon";
const ONYX = "/SF/Types/PickUps/Resources/Inorganics/CorruptOnyxResource";
const TALISMAN = "/SF/Upgrades/Skins/Totem/CardinalTotem";
const oid = (n: number) => ({ $oid: n.toString(16).padStart(24, "0") });

/** A minimal inventory: `weapons` instance ids, plus Onyx, Dracs and the counter. */
function inventory(o: { weapons: number[]; onyx: number; dracs: number; trades: number; rank?: number; extra?: object[] }) {
  return {
    Melee: o.weapons.map((n) => ({ ItemType: SWORD, ItemId: oid(n), Quality: "IQ_WORN", AspectFingerprint: { buffs: [{ Tag: "AerialAttackDamageAMod" }] } })),
    WeaponSkins: [
      { ItemType: TALISMAN, ItemId: oid(900) },
      { ItemType: "/SF/Upgrades/Skins/Hair/Hair1", ItemId: oid(901) },
      ...(o.extra ?? []),
    ],
    MiscItems: [{ ItemType: ONYX, ItemCount: o.onyx }],
    RegularCredits: o.dracs,
    TradesRemaining: o.trades,
    PlayerLevel: o.rank ?? 17,
  };
}

describe("trade detection", () => {
  it("reads the tradable items and the counter, skipping appearance-only skins", () => {
    const h = parseHoldings(inventory({ weapons: [1, 2], onyx: 50, dracs: 1000, trades: 18 }));
    expect(Object.keys(h.instances)).toHaveLength(3);
    expect(h.counts[ONYX]).toBe(50);
    expect(h).toMatchObject({ dracs: 1000, tradesRemaining: 18, envoyRank: 17 });
  });

  it("counts trades from the counter's drop, refilling it at the daily reset", () => {
    const h = (trades: number) => parseHoldings(inventory({ weapons: [], onyx: 0, dracs: 0, trades }));
    expect(tradesBetween(h(18), "2026-10-24T10:00:00Z", h(17), "2026-10-24T10:02:00Z")).toBe(1);
    expect(tradesBetween(h(17), "2026-10-24T10:00:00Z", h(17), "2026-10-24T10:02:00Z")).toBe(0);
    // 15 left before midnight, a full 18 after it, then one trade: 17.
    expect(tradesBetween(h(15), "2026-10-24T23:59:00Z", h(17), "2026-10-25T00:01:00Z")).toBe(1);
    expect(tradesBetween(h(15), "2026-10-24T23:59:00Z", h(18), "2026-10-25T00:01:00Z")).toBe(0);
  });

  it("records what was received and given, and the Dracs spent", () => {
    const before = parseHoldings(inventory({ weapons: [1, 2], onyx: 500, dracs: 10_000, trades: 18 }));
    const after = parseHoldings(inventory({ weapons: [1, 2, 3], onyx: 400, dracs: 9_780, trades: 17 }));
    const t = detectTrade(before, "2026-10-24T10:00:00Z", after, "2026-10-24T10:02:00Z");
    expect(t).toMatchObject({
      count: 1,
      received: [{ key: SWORD, count: 1, ids: [oid(3).$oid], weapon: { craftwork: "IQ_WORN", tempers: ["AerialAttackDamageAMod"], moonsteel: false } }],
      given: [{ key: ONYX, count: 100 }],
      dracs: -220,
    });
    expect(detectTrade(before, "2026-10-24T10:00:00Z", { ...after, tradesRemaining: 18 }, "2026-10-24T10:02:00Z")).toBeNull();
  });

  it("ignores a switch to a different account's inventory", () => {
    const mine = parseHoldings(inventory({ weapons: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], onyx: 0, dracs: 0, trades: 18 }));
    const theirs = parseHoldings(inventory({ weapons: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30], onyx: 0, dracs: 0, trades: 9 }));
    expect(detectTrade(mine, "2026-10-24T10:00:00Z", theirs, "2026-10-24T10:02:00Z")).toBeNull();
  });

  it("names and times trades from the game log, and keeps earlier ones from it", () => {
    const entry: Trade = { at: "2026-10-24T18:36:40.004Z", after: "2026-10-24T18:34:39.970Z", count: 1, received: [], given: [], dracs: -440 };
    const log = [
      { at: Date.parse("2026-10-24T18:20:00Z"), partner: "Early", offered: [], received: ["Wreath"] },
      { at: Date.parse("2026-10-24T18:36:22.326Z"), partner: "NordicGhost", offered: ["Fire Fungus"], received: ["Wreath"] },
      { at: Date.parse("2026-10-24T18:40:00Z"), partner: "Later", offered: ["Fire Fungus"], received: [] },
    ];
    const history = attachDeals([entry], log, entry.at);
    expect(history).toHaveLength(2);
    expect(history[0]!.deals).toEqual([
      { when: "2026-10-24T18:36:22.326Z", partner: "NordicGhost", offered: ["Fire Fungus"], received: ["Wreath"] },
    ]);
    // Before SFHelper saw the inventory: kept from the log alone.
    expect(history[1]).toMatchObject({ at: "2026-10-24T18:20:00.000Z", logOnly: true, deals: [{ partner: "Early" }] });
    // After the latest import ("Later") waits for the next import; nothing is added twice.
    expect(attachDeals(history, log, entry.at)).toEqual(history);
  });

  it("shows a full allowance when the last import predates today's reset", () => {
    const h = parseHoldings(inventory({ weapons: [], onyx: 0, dracs: 0, trades: 3 }));
    expect(remainingToday(h, "2026-10-24T10:00:00Z", "2026-10-24T12:00:00Z")).toBe(3);
    expect(remainingToday(h, "2026-10-23T10:00:00Z", "2026-10-24T12:00:00Z")).toBe(18);
  });
});

describe("trade history", () => {
  let home: string | undefined;
  beforeEach(async () => {
    home = process.env.SFHELPER_HOME;
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-trades-"));
  });
  afterEach(() => {
    if (home === undefined) delete process.env.SFHELPER_HOME;
    else process.env.SFHELPER_HOME = home;
  });

  it("records a trade between imports, once, and tags the traded weapon in Pickups", async () => {
    const before = inventory({ weapons: [1, 2], onyx: 500, dracs: 10_000, trades: 18 });
    const after = inventory({ weapons: [1, 2, 3], onyx: 400, dracs: 9_780, trades: 17 });
    const t0 = new Date(Date.now() - 120_000).toISOString();
    const t1 = new Date().toISOString();

    const noLog = async () => [];
    expect((await recordTrades(parseHoldings(before), t0, noLog)).history).toEqual([]);
    const view = await recordTrades(parseHoldings(after), t1, noLog);
    expect(view.history).toHaveLength(1);
    expect(view).toMatchObject({ remaining: 17, max: 18 });
    // The same import again (the page polls) adds nothing.
    expect((await recordTrades(parseHoldings(after), t1, noLog)).history).toHaveLength(1);

    const ctx = { blueprints: {}, pending: [], vendorPurchases: 0, favour: {} };
    const weapon = (n: number) => ({ id: oid(n).$oid, key: SWORD, craftwork: null, tempers: [], xp: 0, moonsteel: false });
    await recordPickups([weapon(1), weapon(2)], ctx);
    const pickups = await recordPickups([weapon(1), weapon(2), weapon(3)], ctx, tradedIds(view.history));
    expect(pickups[0]).toMatchObject({ id: oid(3).$oid, source: "traded" });
  });

  it("records and announces a pickup once when the page and an import diff at the same time", async () => {
    const ctx = { blueprints: {}, pending: [], vendorPurchases: 0, favour: {} };
    const weapon = (n: number, moonsteel = false) => ({ id: oid(n).$oid, key: SWORD, craftwork: null, tempers: [], xp: 0, moonsteel });
    const announced: string[] = [];
    const stop = onMoonsteelAcquired((p) => announced.push(String(p.id)));
    try {
      await recordPickups([weapon(1)], ctx);
      const now = [weapon(1), weapon(2, true)];
      const [a, b] = await Promise.all([recordPickups(now, ctx), recordPickups(now, ctx)]);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(announced).toEqual([oid(2).$oid]);
    } finally {
      stop();
    }
  });
});
