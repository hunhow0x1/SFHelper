import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { findCacheDir, findRootEntry, hostPath, readEntry } from "../src/gamedata/cache";
import { readLanguages } from "../src/gamedata/formats";
import { buildArsenal, buildNames, buildPactArtValues, buildUpgrades, parseFactionCaps, withRetired } from "../src/gamedata/builders";
import { loggedGame } from "../src/server/gameLog";

function tocEntry(name: string, parent: number, offset: number, size: number, stamp = 123n): Buffer {
  const e = Buffer.alloc(96);
  e.writeBigInt64LE(BigInt(offset), 0);
  e.writeBigInt64LE(stamp, 8);
  e.writeInt32LE(size, 16);
  e.writeInt32LE(size, 20);
  e.writeInt32LE(offset < 0 ? -1 : 0, 24);
  e.writeInt32LE(parent, 28);
  e.write(name, 32, "latin1");
  return e;
}

function toc(...entries: Buffer[]): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0x1867c64e, 0);
  head.writeUInt32LE(20, 4);
  return Buffer.concat([head, ...entries]);
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s: string) => Buffer.concat([u32(s.length), Buffer.from(s, "latin1")]);
const uleb = (n: number) => {
  const out: number[] = [];
  do {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n >>>= 7;
  } while (n);
  return Buffer.from(out);
};

describe("reading Soulframe's cache", () => {
  it("finds a file at the top of the cache index, not one in a folder", async () => {
    const index = toc(tocEntry("SF", 0, -1, 0), tocEntry("Packages.bin", 1, 0, 3), tocEntry("Packages.bin", 0, 5, 4));
    const e = findRootEntry(index, "Packages.bin");
    expect(e).toEqual({ name: "Packages.bin", offset: 5, stamp: "123", compSize: 4, decSize: 4 });
    expect(findRootEntry(index, "Packages")).toBeNull();
    expect(() => findRootEntry(Buffer.alloc(16), "Packages.bin")).toThrow();

    const dir = await mkdtemp(join(tmpdir(), "sfh-cache-"));
    await writeFile(join(dir, "H.Misc.cache"), Buffer.from("xxxxxdata"));
    expect((await readEntry(join(dir, "H.Misc.cache"), e!)).toString()).toBe("data");
  });

  it("reads the newest copy after a patch appends a new one", () => {
    const index = toc(
      tocEntry("Packages.bin", 0, 27268465, 3, 0n),
      tocEntry("SF", 0, -1, 0),
      tocEntry("Packages.bin", 0, 35661503, 4, 134383816323410000n),
    );
    expect(findRootEntry(index, "Packages.bin")).toMatchObject({ offset: 35661503, stamp: "134383816323410000", compSize: 4 });
  });

  it("keeps names for types a patch removed, so old kill stats still have names", () => {
    expect(withRetired({ b: "New B", c: "C" }, { a: "Old A", b: "Old B" })).toEqual({ a: "Old A", b: "New B", c: "C" });
    expect(Object.keys(withRetired({ z: "Z", y: "Y" }, { a: "A" }))).toEqual(["z", "y", "a"]);
    expect(withRetired({ z: "Z" }, undefined)).toEqual({ z: "Z" });
  });

  it("maps the game's Windows paths into the Proton prefix", () => {
    const log = "/home/u/.steam/steamapps/compatdata/1/pfx/drive_c/users/steamuser/AppData/Local/Soulframe/EE.log";
    expect(hostPath("C:\\Soulframe\\Downloaded\\Public\\Cache.Windows\\", log, "linux")).toBe(
      "/home/u/.steam/steamapps/compatdata/1/pfx/drive_c/Soulframe/Downloaded/Public/Cache.Windows",
    );
    expect(hostPath("D:\\Games\\Soulframe\\Cache.Windows", log, "linux")).toBe("/home/u/.steam/steamapps/compatdata/1/pfx/dosdevices/d:/Games/Soulframe/Cache.Windows");
    expect(hostPath("C:\\Soulframe\\Cache.Windows\\", "C:\\Users\\u\\AppData\\Local\\Soulframe\\EE.log", "win32")).toBe("C:\\Soulframe\\Cache.Windows");
    expect(hostPath("C:\\Soulframe", "/home/u/EE.log", "linux")).toBeNull();
  });

  it("finds the cache folder the game logged, or the default one next to the log", async () => {
    const root = await mkdtemp(join(tmpdir(), "sfh-pfx-"));
    const appData = join(root, "pfx", "drive_c", "users", "steamuser", "AppData", "Local", "Soulframe");
    const installed = join(root, "pfx", "drive_c", "Soulframe", "Downloaded", "Public", "Cache.Windows");
    await mkdir(appData, { recursive: true });
    await mkdir(installed, { recursive: true });
    const log = join(appData, "EE.log");
    await writeFile(log, "");
    expect(await findCacheDir(log, "C:\\Soulframe\\Downloaded\\Public\\Cache.Windows\\", "linux")).toBeNull();
    await writeFile(join(installed, "H.Misc.toc"), "");
    expect(await findCacheDir(log, "C:\\Soulframe\\Downloaded\\Public\\Cache.Windows\\", "linux")).toBe(installed);

    const fallback = join(appData, "Downloaded", "Public", "Cache.Windows");
    await mkdir(fallback, { recursive: true });
    await writeFile(join(fallback, "H.Misc.toc"), "");
    expect(await findCacheDir(log, null, "linux")).toBe(fallback);
  });

  it("decodes game text, including entries compressed with the shared dictionary", async () => {
    const dictionary = Buffer.from("Strikes harder against foes that are knocked down. ".repeat(40));
    const long = "Strikes harder against foes that are knocked down, and longer.";
    const frame = zstdCompressSync(Buffer.from(long), { dictionary } as object);
    const packed = Buffer.concat([uleb(long.length), frame.subarray(4)]);
    const plain = Buffer.from("Axe");
    const chunk = Buffer.concat([plain, packed]);
    const label = (name: string, offset: number, size: number, flags: number) => {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(offset, 0);
      b.writeUInt16LE(size, 4);
      b.writeUInt16LE(flags, 6);
      return Buffer.concat([str(name), b]);
    };
    const bin = Buffer.concat([
      Buffer.alloc(28),
      u32(1),
      str("_en"),
      u32(dictionary.length),
      dictionary,
      u32(1),
      str("/SF/Language/Weapons/"),
      u32(chunk.length),
      chunk,
      u32(2),
      label("AxeName", 0, plain.length, 0),
      label("AxeDesc", plain.length, packed.length, 0x200),
    ]);
    const dict = await readLanguages(bin);
    expect(Object.keys(dict)).toEqual(["/SF/Language/Weapons/AxeDesc", "/SF/Language/Weapons/AxeName"]);
    expect(dict["/SF/Language/Weapons/AxeName"]).toBe("Axe");
    expect(dict["/SF/Language/Weapons/AxeDesc"]).toBe(long);
  });
});

describe("building SFHelper's data from the game", () => {
  it("names items, weapon variants and Pacts", () => {
    const names = buildNames(
      {
        "/SF/Language/Weapons/FennJotarMeleeWeaponName": "Fenn Jotar",
        "/SF/Language/Weapons/OdeLongSwordWeaponName": "Ode Sword",
        "/SF/Language/Pacts/OrengalName": "Orengal",
        "/SF/Language/Pacts/BearName": "Ursa",
        "/SF/Language/Items/LanternName": "[PH] Lantern",
        "/SF/Language/Syndicates/SilentRoseName": "The Silent Rose",
        "/SF/Language/Currency/CurrencyName": "Dracs",
      },
      new Map(),
    );
    expect(names.items).toMatchObject({
      OdeLongSwordWeapon: "Ode Sword",
      OdeLongSwordMeleeWeapon: "Ode Sword",
      OdeLongSwordsWeapon: "Ode Sword",
      BearSoul: "Ursa",
      WolfSoul: "Orengal",
      FennJotarSwordMeleeWeapon: "Fenn Jotar",
    });
    expect(names.items.Lantern).toBeUndefined();
    expect(names.factions).toEqual({ SilentRoseSyndicate: "The Silent Rose" });
    expect(names.currencies).toEqual({ RegularCredits: "Dracs" });
  });

  it("reads Pact Art numbers and faction rank caps", () => {
    const texts = [
      "LocalizeTag=/SF/Language/Pacts/StalwartName\nFusionLimit=5\nUpgrades={\nUpgradeType=AVATAR_HEALTH_MAX\nOperationType=ADD\nValue=25\nSymbolFilter=\n}",
    ];
    expect(buildPactArtValues({ "/SF/Language/Pacts/StalwartName": "Stalwart" }, texts, { stalwart: { name: "Stalwart" }, brave: { name: "Brave", virtue: "Courage" } })).toEqual({
      stalwart: [{ n: 25, unit: "", sign: true, label: "max Health" }],
    });
    const table = ["| 0 || [[File:FactionStanding.png|20px]] '''5,000'''", "| 1 || [[File:FactionStanding.png]] 20,000"].join("\n");
    expect(parseFactionCaps(table)).toEqual([5000, 20000]);
    expect(parseFactionCaps("no table")).toBeNull();
  });
});

describe("weapons, Pacts and gear straight from the game files", () => {
  const item = (fields: Record<string, string>, tags: string[] = []) =>
    Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\n") + (tags.length ? `\nSearchTags={\n${tags.join("\n")}\n}` : "");
  const dict = {
    "/L/Loksprik": "Loksprik",
    "/L/Goody": "Goody's Edge",
    "/L/Shrike": "Ode Shrike",
    "/L/Hidden": "Hidden Blade",
    "/L/Bullet": "ANY",
    "/L/Summon": "Summon Wolf",
    "/L/Biscuit": "Bairnday Biscuit",
    "/L/Elixir": "Life Elixir",
  };

  it("lists every named weapon and Pact with its slot, style and damage type", () => {
    const texts = [
      item({ ProductCategory: "Melee", LocalizeTag: "/L/Loksprik", TypeName: "/SF/Weapons/Melee/OneHand/LockSuitDagger/LockSuitDaggerMeleeWeapon", MeleeStyle: "MS_DAGGER" }, ["/SF/Language/Game/DT_SLASH_NoIcon"]),
      item({ ProductCategory: "LongGuns", LocalizeTag: "/L/Goody", TypeName: "/SF/Weapons/Melee/OneHand/BitasEdge/SecondaryBitasEdgeDualSickleMeleeWeapon", MeleeStyle: "MS_AKIMBO_SHORT_SWORD" }),
      item({ ProductCategory: "Melee", LocalizeTag: "/L/Hidden", TypeName: "/SF/Weapons/Melee/Hidden", ExcludeFromCodex: "1" }),
      item({ ProductCategory: "MiscItems", LocalizeTag: "/L/Bullet", TypeName: "/SF/Weapons/Guns/SFBulletWeapon" }),
      item({ ProductCategory: "Suits", LocalizeTag: "/L/Shrike", TypeName: "/SF/Souls/OdeHunter/OdeHunterSoul" }),
      item({ ProductCategory: "Suits", LocalizeTag: "/L/Missing", TypeName: "/SF/Souls/Sparrow/SparrowSoul" }),
    ];
    expect(buildArsenal(dict, texts)).toEqual({
      weapons: {
        "/SF/Weapons/Melee/OneHand/BitasEdge/SecondaryBitasEdgeDualSickleMeleeWeapon": { name: "Goody's Edge", slot: "Sidearm", style: "MS_AKIMBO_SHORT_SWORD", damage: null },
        "/SF/Weapons/Melee/OneHand/LockSuitDagger/LockSuitDaggerMeleeWeapon": { name: "Loksprik", slot: "Primary", style: "MS_DAGGER", damage: "SLASH" },
      },
      pacts: { "/SF/Souls/OdeHunter/OdeHunterSoul": "Ode Shrike" },
    });
  });

  it("files wolf treats under Companion gear and leaves out summons and gear the game doesn't show", async () => {
    const consumable = (type: string, tag: string, extra: Record<string, string> = {}) =>
      item({ ProductCategory: "Consumables", LocalizeTag: tag, LocalizeDescTag: "/L/Desc", TypeName: `/SF/Types/Items/Consumables/${type}`, ...extra });
    const texts = [
      consumable("WolfSummon", "/L/Summon", { ShowInInventory: "0" }),
      consumable("WolfCubSummon", "/L/Pup"),
      consumable("PetConsumeables/WoldAdultUpgradePetFood", "/L/Biscuit"),
      consumable("HealingPotion", "/L/Elixir"),
      consumable("Syndicates/LesserChampionVirtueElixir", "/L/Whisp"),
      consumable("Elixers/CloudSwellElixer", "/L/Swell", { LocalizeDescTag: "/L/None" }),
      consumable("Tackle/Hidden", "/L/Hidden", { ShowInInventory: "0" }),
    ];
    const names = { ...dict, "/L/Desc": "A description.", "/L/Pup": "Summon Wolfpup", "/L/Whisp": "Curaidh's Whisp", "/L/Swell": "Cloudswell", "/L/Hidden": "Hidden Lure" };
    const { gear } = await buildUpgrades(names, texts, null, null, {}, async () => null);
    expect(Object.fromEntries(Object.values(gear).map((g) => [g.name, g.kind]))).toEqual({ "Bairnday Biscuit": "Companion", "Life Elixir": "Supplies" });
  });
});

describe("what the game log says about the install", () => {
  it("picks up the build and the cache folder", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(
      log,
      [
        "0.042 Sys [Diag]: Build Label: 2026.10.08.15.20 Retail Windows x64 [Stripped]",
        "0.043 Sys [Diag]: Current time: Sat Oct 31 13:00:03 2026 [UTC: Sat Oct 31 17:00:03 2026]",
        "0.132 Sys [Info]: Scanning C:\\Soulframe\\Downloaded\\Public\\Cache.Windows\\ for cache blocks...",
        "",
      ].join("\n"),
    );
    expect(await loggedGame(log)).toEqual({ log, build: "2026.10.08.15.20", cacheDir: "C:\\Soulframe\\Downloaded\\Public\\Cache.Windows\\" });
  });
});
