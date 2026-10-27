import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AVAKOT_VENDOR,
  acknowledgeAvakot,
  avakotDue,
  avakotDueAt,
  getAvakot,
  noteAvakotAttempt,
  parseVendorInfo,
  recordAvakot,
} from "../src/server/avakot";
import { fetchVendorInfo } from "../helper/fetchVendor";
import { EndpointRefusedError } from "../helper/fetchInventory";
import { getSettings, updateSettings } from "../src/server/settings";

// A real response, trimmed to one of each kind of offer; fetched at FETCHED.
const SAMPLE_PATH = join(import.meta.dirname, "fixtures", "avakot.sample.json");
const FETCHED = Date.parse("2026-10-26T21:02:49.518Z");
const HOUR = 3600_000;
const RIVER_PEARL = "/SF/StoreItems/Types/PickUps/Resources/Organics/RiverPearlResource";
const KNOTWOOD = "/SF/StoreItems/Types/PickUps/Resources/Organics/KnotwoodPlanksResource";
const MORANITE = "/SF/StoreItems/Types/PickUps/Resources/Organics/MoraniteResource";

const sample = () => readFile(SAMPLE_PATH, "utf8");
const by = (leaf: string, offers: { storeItem: string }[]) => offers.find((o) => o.storeItem.endsWith(`/${leaf}`));

describe("Avakot's stock", () => {
  it("reads prices, limits and which offers rotate", async () => {
    const stock = parseVendorInfo(await sample(), FETCHED);
    expect(stock.offers).toHaveLength(8);
    expect(by("RiverPearlResource", stock.offers)).toMatchObject({
      currency: "Dracs", price: 1500, limit: 2, weekly: false, expiry: Date.parse("2026-10-26T23:00:00Z"),
    });
    // Arcs, weekly, and never leaves (the game's 2035 expiry).
    expect(by("KintsugiUpgradeMeleeSRC", stock.offers)).toMatchObject({ currency: "Arcs", price: 52, limit: 1, weekly: true, expiry: null });
    // No purchase limit.
    expect(by("GarrenPactBlueprint", stock.offers)).toMatchObject({ price: 3000, limit: null, expiry: null });
    expect(by("CatalystALargeBundle", stock.offers)).toMatchObject({ currency: "Arcs", price: 57, expiry: Date.parse("2026-10-27T00:00:00Z") });
    // The stock next changes when the first rotating offer leaves.
    expect(stock.nextChange).toBe(Date.parse("2026-10-26T23:00:00Z"));
  });

  it("rejects anything that isn't Avakot's stock", () => {
    expect(() => parseVendorInfo("Vendor /SF/Syndicates/ChampionSyndicateManifest not found!")).toThrow(/unexpected/);
    expect(() => parseVendorInfo(JSON.stringify({ VendorInfo: { TypeName: "/SF/Other", ItemManifest: [] } }))).toThrow();
    expect(AVAKOT_VENDOR).toBe("/SF/Types/Game/AvakotVendorManifest");
  });
});

describe("Avakot's stock history and notifications", () => {
  let home: string | undefined;
  beforeEach(async () => {
    home = process.env.SFHELPER_HOME;
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-avakot-"));
  });
  afterEach(() => {
    if (home === undefined) delete process.env.SFHELPER_HOME;
    else process.env.SFHELPER_HOME = home;
  });

  it("notifies each starred offer once, and only rotating ones", async () => {
    const stock = parseVendorInfo(await sample(), FETCHED);
    const watch = [RIVER_PEARL, MORANITE, "/SF/StoreItems/Types/Recipes/Pacts/GarrenPactBlueprint"];
    const fresh = await recordAvakot(stock, watch);
    expect(fresh.map((o) => o.storeItem)).toEqual([RIVER_PEARL]);
    // The next check still sees the same offer: no second notification.
    expect(await recordAvakot(parseVendorInfo(await sample(), FETCHED + HOUR), watch)).toEqual([]);
  });

  it("doesn't notify about something that was already in stock when starred", async () => {
    const stock = parseVendorInfo(await sample(), FETCHED);
    expect(by("KnotwoodPlanksResource", stock.offers)?.storeItem).toBe(KNOTWOOD);
    await recordAvakot(stock, []);
    await acknowledgeAvakot([KNOTWOOD]);
    expect(await recordAvakot(parseVendorInfo(await sample(), FETCHED + HOUR), [KNOTWOOD])).toEqual([]);
  });

  it("counts each offer once and remembers when it was last in stock", async () => {
    const first = parseVendorInfo(await sample(), FETCHED);
    await recordAvakot(first, []);
    await recordAvakot(first, []);
    let { seen } = await getAvakot(FETCHED);
    expect(seen[RIVER_PEARL]).toEqual({ count: 1, last: Date.parse("2026-10-26T23:00:00Z") });
    // It rotates in again later with a new offer id.
    const again = JSON.parse(await sample());
    const pearl = again.VendorInfo.ItemManifest.find((i: { StoreItem: string }) => i.StoreItem === RIVER_PEARL);
    pearl.Id.$oid = "6ad1bc722c6ca7ea9e4affff";
    pearl.Expiry.$date.$numberLong = String(Date.parse("2026-10-28T02:00:00Z"));
    await recordAvakot(parseVendorInfo(JSON.stringify(again), FETCHED + 26 * HOUR), []);
    ({ seen } = await getAvakot(FETCHED + 26 * HOUR));
    expect(seen[RIVER_PEARL]).toEqual({ count: 2, last: Date.parse("2026-10-28T02:00:00Z") });
  });

  it("asks again only once the stock has changed, and never twice in ten minutes", async () => {
    expect(await avakotDue(FETCHED)).toBe(true); // nothing fetched yet
    await noteAvakotAttempt(FETCHED);
    expect(await avakotDue(FETCHED + 5 * 60_000)).toBe(false);
    await recordAvakot(parseVendorInfo(await sample(), FETCHED), []);
    expect(await avakotDue(FETCHED + 30 * 60_000)).toBe(false); // stock changes at 23:00
    expect(await avakotDueAt()).toBe(Date.parse("2026-10-26T23:00:30Z")); // the app's timer for the next check
    expect(await avakotDue(Date.parse("2026-10-26T23:01:00Z"))).toBe(true);
  });

  it("asks again ten minutes later if DE hadn't rotated the stock yet", async () => {
    const late = Date.parse("2026-10-26T23:00:30Z"); // River Pearl's offer ended at 23:00
    await noteAvakotAttempt(late);
    await recordAvakot(parseVendorInfo(await sample(), late), []);
    expect(await avakotDueAt()).toBe(late + 10 * 60_000);
  });

  it("hides offers that have ended since the last check", async () => {
    await recordAvakot(parseVendorInfo(await sample(), FETCHED), []);
    const { stock } = await getAvakot(Date.parse("2026-10-26T23:30:00Z"));
    expect(by("RiverPearlResource", stock!.offers)).toBeUndefined();
    expect(by("KnotwoodPlanksResource", stock!.offers)).toBeDefined();
    expect(by("HealingPotion", stock!.offers)).toBeDefined();
  });

  it("keeps only store item paths in the starred list", async () => {
    await updateSettings({ avakotWatch: [RIVER_PEARL, RIVER_PEARL, "javascript:alert(1)"] });
    expect((await getSettings()).avakotWatch).toEqual([]); // rejected as a whole
    await updateSettings({ avakotWatch: [RIVER_PEARL, RIVER_PEARL, MORANITE] });
    expect((await getSettings()).avakotWatch).toEqual([RIVER_PEARL, MORANITE]);
    expect((await getSettings()).avakotNotify).toBe(true);
  });
});

describe("vendor request", () => {
  const ACCOUNT = "0123456789abcdef01234567";

  it("asks for one vendor with the session", async () => {
    let asked = "";
    const body = await fetchVendorInfo(ACCOUNT, "1234", AVAKOT_VENDOR, (async (url: string) => {
      asked = url;
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    expect(body).toBe("{}");
    const u = new URL(asked);
    expect(u.pathname).toBe("/api/getVendorInfo.php");
    expect(u.searchParams.get("accountId")).toBe(ACCOUNT);
    expect(u.searchParams.get("nonce")).toBe("1234");
    expect(u.searchParams.get("vendor")).toBe(AVAKOT_VENDOR);
  });

  it("stops on a refusal", async () => {
    const refuse = (async () => new Response("", { status: 429 })) as typeof fetch;
    await expect(fetchVendorInfo(ACCOUNT, "1234", AVAKOT_VENDOR, refuse)).rejects.toBeInstanceOf(EndpointRefusedError);
    await expect(fetchVendorInfo("not-an-id", "1234", AVAKOT_VENDOR, refuse)).rejects.toThrow(/24 hex/);
  });
});
