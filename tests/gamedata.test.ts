import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { findCacheDir, findRootEntry, hostPath, readEntry, tocIndex } from "../src/gamedata/cache";
import { readLanguages } from "../src/gamedata/formats";
import { buildArmour, buildArsenal, buildEnemies, aspectManifests, buildNames, buildPactArtTexts, buildPactArtValues, buildTalismans, buildTempers, buildTotemData, buildUpgrades, itemIconPaths, mergeRuneValues, parseFactionCaps, parseRuneTags, runeValues, withRetired, parseDropTables, bossPortraits, runeDrops, gamePatch } from "../src/gamedata/builders";
import { locValues, parseChunk, parseLocScript } from "../src/gamedata/luau";
import { decodeBC3, encodePng, mipChain, textureImage } from "../src/gamedata/textures";
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

  it("takes weapon, Pact and rune names from the items themselves", () => {
    const texts = [
      "ProductCategory=Melee\nLocalizeTag=/L/Fulkrom\nTypeName=/SF/Weapons/Melee/TwoHand/MockeryAxe/MockeryAxeMeleeWeapon",
      "ProductCategory=Upgrades\nLocalizeTag=/L/Lunarcure\nTypeName=/SF/Upgrades/Runes/Weapon/Magiks/CasterHealingProjectileRune",
      "ProductCategory=Upgrades\nLocalizeTag=/L/Breath\nTypeName=/SF/Upgrades/Runes/Weapon/Bow/StarterRune",
      "ProductCategory=Upgrades\nLocalizeTag=/L/Hurlwind\nTypeName=/SF/Upgrades/Runes/Weapon/Flyblade/StarterRune",
    ];
    const dict = {
      "/SF/Language/Weapons/MockeryAxeMeleeWeaponName": "Dolush",
      "/L/Fulkrom": "Fulkrom",
      "/L/Lunarcure": "Lunarcure",
      "/L/Breath": "Alca's Breath",
      "/L/Hurlwind": "Hurlwind",
    };
    expect(buildNames(dict, new Map(), texts).items).toMatchObject({
      MockeryAxeMeleeWeapon: "Fulkrom",
      "/SF/Upgrades/Runes/Weapon/Magiks/CasterHealingProjectileRune": "Lunarcure",
      "/SF/Upgrades/Runes/Weapon/Bow/StarterRune": "Alca's Breath",
      "/SF/Upgrades/Runes/Weapon/Flyblade/StarterRune": "Hurlwind",
    });
  });

  it("names enemies whose type lists the same words as their codex entry in another order", () => {
    const base = "/SF/Types/Enemies/Wildlife/Mockeries";
    const tree = new Map<string, string | null>([
      [`${base}/MockeryStoneWomanArmoredSubBossAvatar`, `${base}/MockeryStoneWomanAvatar`],
      [`${base}/MockeryStoneWomanAvatar`, `${base}/MockeryBaseAvatar`],
      [`${base}/MockeryStoneManArmoredAvatar`, `${base}/MockeryBaseAvatar`],
    ]);
    const enemies = buildEnemies(
      {
        "/SF/Language/Codex/MockeryStoneArmoredWomanSubbossAvatarName": "Ceptet",
        "/SF/Language/Codex/MockeryStoneArmoredManAvatarName": "Gravestone Mockery",
      },
      tree,
    );
    expect(enemies.names).toMatchObject({ mockerystonewomanarmoredsubbossavatar: "Ceptet", mockerystonemanarmoredavatar: "Gravestone Mockery" });
    expect(enemies.names.mockerystonewomanavatar).toBeUndefined();
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

  it("reads the patch from the game's update title", () => {
    expect(gamePatch({ "/SF/Language/Updates/TitleText": "Preludes 17: Verse of the Veilands" })).toBe("P17");
    expect(gamePatch({ "/SF/Language/Updates/TitleText": "Preludes 17.5" })).toBe("P17.5");
    expect(gamePatch({})).toBeNull();
    expect(buildArsenal({ "/SF/Language/Updates/TitleText": "Preludes 17: Verse of the Veilands" }, [])).toEqual({ patch: "P17", weapons: {}, pacts: {} });
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
    const { gear } = await buildUpgrades(names, texts, null, null, async () => null);
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
    expect(await loggedGame(log)).toEqual({ log, build: "2026.10.08.15.20", cacheDir: "C:\\Soulframe\\Downloaded\\Public\\Cache.Windows\\", publicAddress: null });
  });
});

describe("runes, Talismans and armour from the game files", () => {
  const def = (fields: Record<string, string>, extra = "") => Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\n") + (extra ? `\n${extra}` : "");
  const dict = {
    "/L/Lunar": "Lunarcure",
    "/L/LunarDesc": "The rune of spiritsalve, ease your rally.",
    "/L/LunarText": "Cast enchanted magick that deals +|DAMAGE|% Arcanic Damage and heals Envoys for |HEAL|% of their Health.",
    "/L/Charm": "Cardinal Charm",
    "/L/Braes": "Ceptet's Gaiters",
    "/L/Mask": "Ceptet's Headstone",
    "/L/Old": "Arbearer's Braes",
  };

  it("takes a rune's in-game description and Totem slot from its definition", async () => {
    const icon = "/SF/Interface/Graphics/Runes/Alca/AlcaSpirit012.png";
    const type = "/SF/Upgrades/Runes/Weapon/Magiks/CasterHealingProjectileRune";
    const texts = [
      def({ ProductCategory: "Upgrades", LocalizeTag: "/L/Lunar", LocalizeDescTag: "/L/LunarDesc", Icon: icon, TypeName: type }, "SearchTags={\n/L/Magick\n}"),
      def({ LocalizeTag: "/L/Lunar", Icon: icon, EnhancementTag: "/L/LunarText" }, "BonusArtifactSlots={\nAP_DEFENSE\n}"),
    ];
    const stats = [
      { effect: "$1 Arcanic Damage Bonus", values: ["50%", "75%", "100%", "125%"] },
      { effect: "Healing", values: ["20%", "25%", "30%", "35%"] },
    ];
    const wiki = new Map([[type, { name: "Lunarcure", id: type, icon: null, art: null, does: null, slot: null, stats }]]);
    const drawn: (string | null)[] = [];
    const { runes } = await buildUpgrades({ ...dict, "/L/Magick": "Magick" }, texts, wiki, null, async (p) => {
      drawn.push(p);
      return "img/game/rune.png";
    });
    expect(runes[type]).toMatchObject({
      name: "Lunarcure",
      text: dict["/L/LunarText"],
      vals: { DAMAGE: ["50", "75", "100", "125"], HEAL: ["20", "25", "30", "35"] },
      slot: "Spirit",
      art: "Magick",
      icon: "img/game/rune.png",
    });
    expect(drawn).toEqual([icon]);
  });

  it("matches the wiki's numbers to a description's placeholders by what they measure", () => {
    const treefell = "Increases the speed of charging Heavy Attacks by |BONUS|%, and bypasses |BONUS2| Defence for |DURATION| seconds.";
    const stats = [
      { effect: "Charge Speed", values: ["40%", "60%", "80%", "100%"] },
      { effect: "Duration", values: ["5s", "6s", "7s", "8s"] },
      { effect: "$1 Armour Penetration", values: ["10", "30", "50", "70"] },
    ];
    expect(runeValues(treefell, stats)).toEqual({ BONUS: ["40", "60", "80", "100"], BONUS2: ["10", "30", "50", "70"], DURATION: ["5", "6", "7", "8"] });
    expect(runeValues("Creates a cloaking shadow for |DURATION| seconds, extended by |BONUS| seconds.", [stats[1]!])).toBeNull();
    expect(runeValues("Throw for |STAGGER|% Stagger.", [{ effect: "Stagger Bonus", values: ["x%", "x%", "x%", "350%"] }])).toBeNull();
  });

  it("reads Talisman Virtues and armour stats, keeping set names it already had", () => {
    const charm = "/SF/Interface/Graphics/StoreItems/Totems/CardinalTalisman.png";
    const virtue = (v: string, n: number) => `UpgradeType=AVATAR_ATTRIBUTE_PRIMARY_${v}\nOperationType=ADD_BASE\nValue=${n}`;
    const piece = (folder: string, leaf: string, tag: string, body: string) => [
      def({ ProductCategory: "WeaponSkins", LocalizeTag: tag, Icon: `/I/${leaf}.png`, TypeName: `/SF/Upgrades/Skins/${folder}/${leaf}` }),
      def({ LocalizeTag: tag, Icon: `/I/${leaf}.png` }, body),
    ];
    const texts = [
      def({ ProductCategory: "WeaponSkins", LocalizeTag: "/L/Charm", Icon: charm, TypeName: "/SF/Upgrades/Skins/Totem/CardinalTotem" }),
      def({ LocalizeTag: "/L/Charm", Icon: charm }, `Upgrades={\n{\n${virtue("GRACE", 1)}\n},\n{\n${virtue("SPIRIT", 2)}\n},\n{\n${virtue("COURAGE", 1)}\n}\n}`),
      ...piece("Legs", "MockeryStoneLegs", "/L/Braes", "Rarity=RARE\nArmour={\nPhysical=5\nMagick=1\nStability=4\n}\nRequirements={\nAT_COURAGE=19\n}"),
      ...piece("Helmets", "MockeryStoneHelmet", "/L/Mask", "Armour={\nPhysical=4\nMagick=2\nStability=2\n}"),
      ...piece("Legs", "BromiusLegs", "/L/Old", "Rarity=RARE\nArmour={\nPhysical=5\nMagick=1\nStability=4\n}\nRequirements={\nAT_COURAGE=19\n}"),
    ];
    expect(buildTalismans(dict, texts)).toEqual({ CardinalTotem: { name: "Cardinal Charm", Courage: 1, Spirit: 2, Grace: 1 } });
    const previous = { "Arbearer's Braes": { slot: "Leggings" as const, set: "Arbearer", rarity: "Rare", physical: 5, magick: 1, stability: 4, requires: null }, "Helmless": { slot: "Helm" as const, set: "Underwear", rarity: "Common", physical: 0, magick: 0, stability: 0, requires: null } };
    expect(buildArmour(dict, texts, previous)).toEqual({
      "Arbearer's Braes": { slot: "Leggings", set: "Arbearer", rarity: "Rare", physical: 5, magick: 1, stability: 4, requires: { virtue: "Courage", value: 19 } },
      "Ceptet's Gaiters": { slot: "Leggings", set: "Ceptet", rarity: "Rare", physical: 5, magick: 1, stability: 4, requires: { virtue: "Courage", value: 19 } },
      "Ceptet's Headstone": { slot: "Helm", set: "Ceptet", rarity: "Common", physical: 4, magick: 2, stability: 2, requires: null },
      "Helmless": { slot: "Helm", set: "Underwear", rarity: "Common", physical: 0, magick: 0, stability: 0, requires: null },
    });
  });

  it("lists item icons by name, preferring items over other things with the same name", () => {
    const texts = [
      def({ ProductCategory: "Recipes", LocalizeTag: "/L/Lunar", Icon: "/I/Recipe.png", TypeName: "/SF/Types/Recipes/X" }),
      def({ ProductCategory: "Upgrades", LocalizeTag: "/L/Lunar", Icon: "/I/Rune.png", TypeName: "/SF/Upgrades/Runes/X" }),
      def({ ProductCategory: "MiscItems", LocalizeTag: "/L/Charm", Icon: "/I/Charm.png", TypeName: "/SF/Types/Charm" }),
    ];
    expect(Object.fromEntries(itemIconPaths(dict, texts))).toEqual({ "Cardinal Charm": "/I/Charm.png", Lunarcure: "/I/Rune.png" });
  });
});

describe("icons drawn from the game's textures", () => {
  it("knows the mip layout of the small texture parts", () => {
    expect(mipChain(21872)).toEqual({ top: 128, blockBytes: 16 });
    expect(mipChain(5488)).toEqual({ top: 64, blockBytes: 16 });
    expect(mipChain(43704)).toEqual({ top: 256, blockBytes: 8 });
    expect(mipChain(1000)).toBeNull();
  });

  it("decodes BC3 blocks, keeps the largest level and writes a PNG", () => {
    const block = Buffer.from([0xff, 0x00, 0, 0, 0, 0, 0, 0, 0x00, 0xf8, 0x1f, 0x00, 0, 0, 0, 0]);
    expect([...decodeBC3(block, 4, 4).subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    const chain = Buffer.concat([Buffer.alloc(16 * 3, 0), Buffer.concat(Array.from({ length: 4 }, () => block))]);
    const img = textureImage(chain, 64);
    expect(img?.side).toBe(8);
    const png = encodePng(img!.rgba, img!.side, img!.side);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(8);
  });

  it("finds files in nested cache folders by their full path", () => {
    const index = tocIndex(toc(tocEntry("SF", 0, -1, 0), tocEntry("Interface", 1, -1, 0), tocEntry("Rat.png", 2, 100, 10, 5n), tocEntry("Rat.png", 2, 200, 10, 9n)));
    expect([...index.keys()]).toEqual(["/SF/Interface/Rat.png"]);
    expect(index.get("/SF/Interface/Rat.png")).toMatchObject({ offset: 200, stamp: "9" });
  });
});

describe("rune numbers from the game's scripts", () => {
  const abc = (op: number, a = 0, b = 0, c = 0) => (op | (a << 8) | (b << 16) | (c << 24)) >>> 0;
  const ad = (op: number, a: number, d: number) => (op | (a << 8) | ((d & 0xffff) << 16)) >>> 0;
  const proto = (o: { stack: number; params: number; vararg?: boolean; code: number[]; k: number[][]; children?: number[] }): number[] => {
    const code = Buffer.alloc(o.code.length * 4);
    o.code.forEach((w, i) => code.writeUInt32LE(w, i * 4));
    return [o.stack, o.params, 0, o.vararg ? 1 : 0, 0, 0, o.code.length, ...code, o.k.length, ...o.k.flat(), (o.children ?? []).length, ...(o.children ?? []), 0, 0, 0, 0];
  };
  const num = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n);
    return [2, ...b];
  };
  const str = (name: string) => [name.length, ...Buffer.from(name, "latin1")];
  const stats = proto({
    stack: 3,
    params: 1,
    code: [abc(0x0e, 1), 0, ad(0x1d, 0, 3), 0x80000000, ad(0x29, 2, 50), ad(0x47, 0, 1), abc(0x4b, 2, 0, 1), abc(0x3f, 2, 1, 0), 2, abc(0x3c, 1, 2)],
    k: [num(1), num(25), [3, 1]],
  });
  const main = proto({ stack: 1, params: 0, vararg: true, code: [abc(0x09), ad(0x36, 0, 0), abc(0x00), 0, abc(0x3c, 0, 1)], k: [[3, 2]], children: [0] });
  const bytes = Buffer.from([6, 3, 2, ...str("DAMAGE"), ...str("GetAbilityStats"), 0, 2, ...stats, ...main, 1]);
  const path = "/SF/Upgrades/Runes/Weapon/Test/TestRune.lua";

  it("reads a compiled script and runs its per-rank function", async () => {
    const chunk = parseChunk(bytes);
    expect(chunk.protos).toHaveLength(2);
    const scripts = new Map([[path, chunk]]);
    const source = { chunk: async (p: string) => scripts.get(p) ?? null, loaded: () => scripts };
    const def = "EnhancementTag=/SF/Test\nEnhancementTagLocScript={\nScript=TestRune.lua\nFunction=GetAbilityStats\n_damageType=DT_FIRE\n_fx=\"\"\n}\n";
    const ls = parseLocScript(def, "/SF/Upgrades/Runes/Weapon/Test/Rune");
    expect(ls).toEqual({ script: path, fn: "GetAbilityStats", params: { _damageType: "DT_FIRE", _fx: "" } });
    expect(await locValues(source, ls!)).toEqual({ DAMAGE: ["50", "50", "75", "100"] });
    expect(await locValues(source, { ...ls!, fn: "Missing" })).toBeNull();
  });

  it("prefers the game's numbers and fills gaps from the wiki", () => {
    const text = "Deals |DAMAGE|% for |DURATION| seconds.";
    expect(mergeRuneValues(text, { DAMAGE: ["1", "2", "3", "4"] }, { DAMAGE: ["9", "9", "9", "9"], DURATION: ["5", "6", "7", "8"] })).toEqual({ DAMAGE: ["1", "2", "3", "4"], DURATION: ["5", "6", "7", "8"] });
    expect(mergeRuneValues(text, { DAMAGE: ["1", "2", "3", "4"] }, null)).toBeNull();
    expect(mergeRuneValues(null, { DAMAGE: ["1"] }, null)).toBeNull();
  });
});

describe("Tempers, Totem cards and Pact Arts in the game's own words", () => {
  const dict = {
    "/T/N": "From Above",
    "/T/D": "Increases Weapon Damage during Aerial Attacks.",
    "/M/N": "Far Foul",
    "/M/D": "Within feather's reach",
    "/M/E": "Increases Pull Smite Range by +|RANGE|m.",
    "/SF/Language/Pacts/XName": "Barkbare",
    "/SF/Language/Pacts/XDesc": "Like grafting tree bark.",
  };
  const icon = "Icon=/SF/Interface/Graphics/Animotes/Animals/Rabbit.png\n";
  const texts = [
    "LocalizeTag=/T/N\nLocalizeDescTag=/T/D\nTypeName=/SF/Types/Items/Aspects/Tempers/AerialAttackDamageAMod\n",
    `LocalizeTag=/M/N\nLocalizeDescTag=/M/D\n${icon}TypeName=/SF/Upgrades/Totems/FarFoul\n`,
    `LocalizeTag=/M/N\nLocalizeDescTag=/M/D\n${icon}EnhancementTag=/M/E\n`,
    "LocalizeTag=/SF/Language/Pacts/XName\nLocalizeDescTag=/SF/Language/Pacts/XDesc\nFusionLimit=QA_MEDIUM\n",
  ];

  it("uses the game's descriptions and script numbers", async () => {
    expect(buildTempers(dict, texts)).toEqual({ AerialAttackDamageAMod: { name: "From Above", effect: "Increases Weapon Damage during Aerial Attacks." } });
    const values = async (_type: string, _def: string, variant?: number) => ({ RANGE: variant === 1 ? ["3", "4", "6", "8"] : ["2", "3", "4", "5"] });
    const prev = { "Far Foul": { animal: "Hare", enhances: "Pull Smite", description: "", effect: "", base: [], grip: [] } };
    expect(await buildTotemData(dict, texts, prev, values)).toEqual({
      "Far Foul": { animal: "Hare", enhances: "Pull Smite", description: "Within feather's reach", effect: "Increases Pull Smite Range by +$1m.", base: [["2", "3", "4", "5"]], grip: [["3", "4", "6", "8"]] },
    });
    expect((await buildTotemData(dict, texts, null, async () => null))["Far Foul"]).toMatchObject({ animal: "Rabbit", base: [[]] });
    expect(buildPactArtTexts(dict, texts)).toEqual({ Barkbare: "Like grafting tree bark." });
  });
});

describe("which weapons each Temper can roll on", () => {
  const manifest = (tag: string, entries: [string, string][]) =>
    `MarketMode=MM_HIDDEN\nLocalizeTag=${tag}\nItemCompatibility=/SF/Types/Game/SFCasterMeleeWeapon\nUpgradeEntries={\n${entries.map(([t, i]) => `{\nTag=${t}\nIcon=${i}\n}`).join(",\n")}\n}`;
  const tree = new Map<string, string | null>([
    ["/SF/Types/Items/Aspects/BaseAspectManifest", null],
    ["/SF/Types/Items/Aspects/FeyLightMeleeAspectManifest", null],
    ["/SF/Types/Items/Aspects/OdeRangedAspectManifest", null],
  ]);
  const texts = [
    manifest("/SF/Language/Menu/OriginFey", [["CritChanceMod", "/SF/Interface/Graphics/Aspects/Universal/Smite.png"], ["FeyMod", "/SF/Interface/Graphics/Aspects/Fey/Duplicate.png"]]),
    manifest('"[HC] OdeRangedAspectManifest"', [["CritChanceMod", '""']]),
    "TypeName=/SF/Weapons/Melee/Rapier/RapierWeapon\nAspectManifest=/SF/Types/Items/Aspects/FeyLightMeleeAspectManifest",
    "TypeName=/SF/Weapons/Bow/BowWeapon\nAspectManifest=/SF/Types/Items/Aspects/OdeRangedAspectManifest",
    "LocalizeTag=/T/Crit\nLocalizeDescTag=/T/CritD\nTypeName=/SF/Types/Items/Aspects/Tempers/CritChanceMod",
    "LocalizeTag=/T/Fey\nLocalizeDescTag=/T/FeyD\nTypeName=/SF/Types/Items/Aspects/Tempers/FeyMod",
  ];
  const dict = { "/T/Crit": "Smite", "/T/CritD": "More Smites.", "/T/Fey": "Duplicate", "/T/FeyD": "Twice." };

  it("lines manifests up with their types and lists the weapons that use them", () => {
    const manifests = aspectManifests(texts, tree);
    expect([...manifests.keys()]).toEqual(["/SF/Types/Items/Aspects/FeyLightMeleeAspectManifest", "/SF/Types/Items/Aspects/OdeRangedAspectManifest"]);
    const tempers = buildTempers(dict, texts, manifests, { "/SF/Weapons/Melee/Rapier/RapierWeapon": "Navalha", "/SF/Weapons/Bow/BowWeapon": "Avex" });
    expect(tempers.CritChanceMod).toEqual({ name: "Smite", effect: "More Smites.", icon: "/SF/Interface/Graphics/Aspects/Universal/Smite.png", weapons: ["Avex", "Navalha"] });
    expect(tempers.FeyMod!.weapons).toEqual(["Navalha"]);
  });

  it("gives up rather than guess when the order doesn't line up", () => {
    const swapped = new Map([...tree].reverse());
    expect(aspectManifests(texts, swapped).size).toBe(0);
  });

  it("reads rune tags from the wiki's rune data", () => {
    const lua = '{\n  ["The Torrent"] = {\n    InternalID= "/SF/Upgrades/Runes/Weapon/Bow/X",\n    Tags= "Cogah",\n  },\n  ["Hurlwind"] = {\n    InternalID= "/SF/Upgrades/Runes/Weapon/Bow/Y",\n  },\n}';
    expect(parseRuneTags(lua)).toEqual(new Map([["/SF/Upgrades/Runes/Weapon/Bow/X", ["Cogah"]], ["/SF/Upgrades/Runes/Weapon/Bow/Y", []]]));
  });
});

describe("where each rune drops", () => {
  const lua = `return {
\t["SpiderSubBoss"] = {
\t\tTags = "Foes",
\t\tSources = {
\t\t\t{
\t\t\t\tName = "Etheldred The Weaver",
\t\t\t\tLink = "Etheldred The Weaver",
\t\t\t},
\t\t\t{
\t\t\t\tName = "Seachnall The Widower",
\t\t\t\tLink = "Seachnall The Widower",
\t\t\t},
\t\t},
\t\tDrops =
\t\t\t{
\t\t\t\t{ Name = "Emberaught", Quantity = "1" },
\t\t\t}
\t},
\t["HunterRednightBoss"] = {
\t\tTags = "Foes",
\t\tSources = {
\t\t\t{
\t\t\t\tName = "Gruul-Seeker Ruthos (Cogah)",
\t\t\t\tLink = "Gruul-Seeker Ruthos",
\t\t\t},
\t\t},
\t\tDrops =
\t\t\t{
\t\t\t\t{ Name = "The Torrent", Quantity = "1" },
\t\t\t\t{ Name = "Hunter's Hood", Quantity = "1" },
\t\t\t}
\t},
\t["KearnholdSiegeMissionRewardItemManifest"] = {
\t\tTags = "Sieges",
\t\tSources = {
\t\t\t{
\t\t\t\tName = "Fort Kearnhold Siege",
\t\t\t\tLink = "Fort Kearnhold",
\t\t\t},
\t\t},
\t\tDrops =
\t\t\t{
\t\t\t\t{ Name = "Emberaught", Quantity = "1" },
\t\t\t}
\t},
\t["FortressODellDungeonVotiveRewardManifest"] = {
\t\tTags = "Votives",
\t\tSources = {
\t\t\t{
\t\t\t\tName = "Fortress O'Dell#Dungeon Votive",
\t\t\t\tLink = "Fortress O'Dell#Dungeon Votive",
\t\t\t},
\t\t},
\t\tDrops =
\t\t\t{
\t\t\t\t{ Name = "Emberaught", Quantity = "1" },
\t\t\t}
\t},
}`;
  const enemies = {
    names: { spidersubbossavatar: "Etheldred The Weaver", spidersubbossprocavatar: "Seachnall The Widower", rangedhuntersubbossavatar: "Gruulseeker Ruthos" },
    parents: { SpiderSubBossAvatar: "GruntAvatarBase", SpiderSubBossProcAvatar: "SpiderSubBossAvatar", RangedHunterSubBossAvatar: "RangedHunterEliteAvatar", RangedHunterEliteAvatar: "GruntAvatarBase" },
  };
  const texts = [
    "LocTag=/SF/Language/Codex/SpiderSubbossAvatarName\nIcon=/SF/Interface/Graphics/StoreItems/Codex/SubBosses/SpiderSubBoss.png",
    "LocTag=/SF/Language/Codex/SpiderSubbossProcAvatarName",
    "LocTag=/SF/Language/Codex/RangedHunterEliteAvatarName\nIcon=/SF/Interface/Graphics/StoreItems/Codex/Ode/RangedHunterElite.png",
    "LocTag=/SF/Language/Codex/RangedHunterSubbossAvatarName",
  ];

  it("reads the wiki's drop tables", () => {
    const tables = parseDropTables(lua);
    expect(tables.map((t) => t.key)).toEqual(["SpiderSubBoss", "HunterRednightBoss", "KearnholdSiegeMissionRewardItemManifest", "FortressODellDungeonVotiveRewardManifest"]);
    expect(tables[1]).toEqual({ key: "HunterRednightBoss", tags: "Foes", sources: ["Gruul-Seeker Ruthos (Cogah)"], drops: ["The Torrent", "Hunter's Hood"] });
  });

  it("names Agari as the game does, with their codex portraits", () => {
    const bosses = bossPortraits(texts, enemies);
    expect(bosses.get("seachnallthewidower")).toEqual({ name: "Seachnall The Widower", icon: "/SF/Interface/Graphics/StoreItems/Codex/SubBosses/SpiderSubBoss.png" });
    expect(bosses.get("gruulseekerruthos")).toEqual({ name: "Gruulseeker Ruthos", icon: "/SF/Interface/Graphics/StoreItems/Codex/Ode/RangedHunterElite.png" });

    const drops = runeDrops(parseDropTables(lua), { "/R/Emberaught": "Emberaught", "/R/Torrent": "The Torrent", "/R/Other": "Hurlwind" }, bosses);
    expect(drops["/R/Emberaught"]).toEqual({
      bosses: [
        { name: "Etheldred The Weaver", icon: "/SF/Interface/Graphics/StoreItems/Codex/SubBosses/SpiderSubBoss.png" },
        { name: "Seachnall The Widower", icon: "/SF/Interface/Graphics/StoreItems/Codex/SubBosses/SpiderSubBoss.png" },
      ],
      sieges: ["Fort Kearnhold Siege"],
      votives: ["Fortress O'Dell Dungeon Votive"],
    });
    expect(drops["/R/Torrent"]).toEqual({ bosses: [{ name: "Gruulseeker Ruthos", icon: "/SF/Interface/Graphics/StoreItems/Codex/Ode/RangedHunterElite.png", cogah: true }] });
    expect(drops["/R/Other"]).toBeUndefined();
  });
});
