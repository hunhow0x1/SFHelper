import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../server/files";
import { readGameFiles, type GameFiles } from "./cache";
import { readLanguages, readPackageTexts, readTypeTree } from "./formats";
import {
  buildArsenal,
  buildAvakot,
  buildEnemies,
  buildLocations,
  buildNames,
  buildPactArtValues,
  buildRecipes,
  buildUpgrades,
  parseCraftingTable,
  parseFactionCaps,
  parseWikiIcons,
  parseWikiImages,
  parseWikiRunes,
  withRetired,
  type ArsenalData,
  type AvakotPool,
  type RecipeDef,
  type UpgradeData,
  type WikiRune,
} from "./builders";
import type { Wiki } from "./wiki";

export const GAME_DATA_FILES = [
  "names.json",
  "enemies.json",
  "locations.json",
  "pactartvalues.json",
  "itemicons.json",
  "upgrades.json",
  "avakot.json",
  "faction-ranks.json",
  "recipes.json",
  "arsenal.json",
];

const MAX_DOWNLOADS = 60;
const RECIPE_IMAGE_MODULES = ["Weapons", "Armour", "Pacts", "Cosmetics", "Misc", "CraftingResources", "Consumables"];
const MIN_KEPT = 0.8;
const DEFAULT_CAPS = [5000, 5000, 20000, 20000, 30000, 30000];

export interface UpdateOptions {
  cacheDir?: string;
  files?: GameFiles;
  outDir: string;
  bundledDir: string;
  wiki?: Wiki | null;
  shrinkIcon?: (png: Buffer) => Buffer | Promise<Buffer>;
  maxDownloads?: number;
  log?: (msg: string) => void;
}

export interface UpdateResult {
  hash: string;
  changed: string[];
  failed: string[];
  incomplete: boolean;
  downloads: number;
  summary: string;
}

const slug = (s: string): string => s.toLowerCase().replace(/\.png$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const readText = (p: string): Promise<string | null> => readFile(p, "utf8").catch(() => null);

export function wikiEntry<T>(table: Map<string, T>, r: Pick<RecipeDef, "name" | "gives">): T | undefined {
  if (r.gives > 1) return table.get(`${r.name} (Cratesweight)`);
  const direct = table.get(r.name) ?? table.get(`${r.name} (Consumable)`);
  if (direct !== undefined) return direct;
  const named = [...table.keys()].filter((k) => k.startsWith(`${r.name}'s `));
  return named.length === 1 ? table.get(named[0]!) : undefined;
}

function enough(label: string, fresh: number, previous: number | undefined): void {
  if (previous && fresh < previous * MIN_KEPT) throw new Error(`${label}: only ${fresh} found (had ${previous}), keeping the old list`);
}

export async function updateGameData(o: UpdateOptions): Promise<UpdateResult> {
  const files = o.files ?? (await readGameFiles(o.cacheDir ?? ""));
  const sameDir = o.outDir === o.bundledDir;
  const wiki = o.wiki ?? null;
  const changed: string[] = [];
  const failed: string[] = [];
  const counts: string[] = [];
  let incomplete = false;
  let downloads = 0;

  const dict = await readLanguages(files.languages);
  if (Object.keys(dict).length < 1000) throw new Error(`Languages.bin: only ${Object.keys(dict).length} texts`);
  const tree = await readTypeTree(files.packages);
  const texts = await readPackageTexts(files.packages);
  const unique = [...new Set(texts)];

  const served = async (name: string): Promise<string | null> => (sameDir ? null : await readText(join(o.outDir, name))) ?? (await readText(join(o.bundledDir, name)));
  const previous = async <T>(name: string): Promise<T | null> => {
    const text = await served(name);
    try {
      return text ? (JSON.parse(text) as T) : null;
    } catch {
      return null;
    }
  };
  const put = async (name: string, text: string): Promise<void> => {
    const before = await served(name);
    if (sameDir) {
      if (before !== text) await writeFileAtomic(join(o.outDir, name), text);
    } else if ((await readText(join(o.bundledDir, name))) === text) {
      await rm(join(o.outDir, name), { force: true });
    } else {
      await writeFileAtomic(join(o.outDir, name), text);
    }
    if (before !== text) changed.push(name);
  };
  const step = async (name: string, run: () => Promise<string | null>): Promise<void> => {
    try {
      const note = await run();
      if (note) counts.push(note);
    } catch (err) {
      failed.push(name);
      incomplete = true;
      o.log?.(`${name}: ${(err as Error).message}`);
    }
  };

  const icon = async (dir: string, file: string, as = slug(file)): Promise<string | null> => {
    const rel = `${dir}/${as}.png`;
    if ((await exists(join(o.outDir, rel))) || (await exists(join(o.bundledDir, rel)))) return rel;
    if (!wiki || downloads >= (o.maxDownloads ?? MAX_DOWNLOADS)) return null;
    const png = await wiki.image(file);
    if (!png) return null;
    await writeFileAtomic(join(o.outDir, rel), o.shrinkIcon ? await o.shrinkIcon(png) : png);
    downloads += 1;
    return rel;
  };
  const iconTable = async (modules: string[]): Promise<Map<string, string> | null> => {
    if (!wiki) return null;
    const table = new Map<string, string>();
    for (const mod of modules) {
      const lua = await wiki.wikitext(`Module:Data/${mod}`);
      if (lua === null) return null;
      parseWikiIcons(lua, table);
    }
    return table;
  };
  const imageTable = async (modules: string[]): Promise<Map<string, string> | null> => {
    if (!wiki) return null;
    const table = new Map<string, string>();
    for (const mod of modules) {
      const lua = await wiki.wikitext(`Module:Data/${mod}`);
      if (lua === null) return null;
      parseWikiImages(lua, table);
    }
    return table;
  };

  let names = buildNames(dict, tree);
  await step("names.json", async () => {
    const prev = await previous<typeof names>("names.json");
    enough("names", Object.keys(names.items).length, Object.keys(prev?.items ?? {}).length);
    names = { ...names, items: withRetired(names.items, prev?.items) };
    await put("names.json", JSON.stringify(names, null, 2));
    return `${Object.keys(names.items).length} names`;
  });
  if (failed.includes("names.json")) names = (await previous<typeof names>("names.json")) ?? names;

  await step("enemies.json", async () => {
    const fresh = buildEnemies(dict, tree);
    const prev = await previous<Partial<typeof fresh>>("enemies.json");
    enough("enemies", Object.keys(fresh.names).length, Object.keys(prev?.names ?? {}).length);
    const enemies = { names: withRetired(fresh.names, prev?.names), parents: withRetired(fresh.parents, prev?.parents) };
    await put("enemies.json", `${JSON.stringify(enemies, null, 1)}\n`);
    return `${Object.keys(enemies.names).length} enemies`;
  });

  await step("locations.json", async () => {
    const { locations } = buildLocations(dict, tree, texts);
    enough("locations", Object.keys(locations).length, Object.keys((await previous<{ locations: object }>("locations.json"))?.locations ?? {}).length);
    await put("locations.json", `${JSON.stringify({ locations }, null, 2)}\n`);
    return `${Object.keys(locations).length} locations`;
  });

  await step("arsenal.json", async () => {
    const arsenal = buildArsenal(dict, unique);
    const size = (a: Partial<ArsenalData> | null) => Object.keys(a?.weapons ?? {}).length + Object.keys(a?.pacts ?? {}).length;
    enough("weapons and Pacts", size(arsenal), size(await previous<Partial<ArsenalData>>("arsenal.json")));
    await put("arsenal.json", `${JSON.stringify(arsenal, null, 2)}\n`);
    return `${Object.keys(arsenal.weapons).length} weapons, ${Object.keys(arsenal.pacts).length} Pacts`;
  });

  await step("pactartvalues.json", async () => {
    const arts = await previous<Record<string, { name: string; virtue?: unknown }>>("pactarts.json");
    if (!arts) throw new Error("no pactarts.json to match against");
    const values = buildPactArtValues(dict, texts, arts);
    await put("pactartvalues.json", `${JSON.stringify(values, null, 2)}\n`);
    return `${Object.keys(values).length} Pact Art values`;
  });

  let itemIcons = (await previous<Record<string, string>>("itemicons.json")) ?? {};
  await step("itemicons.json", async () => {
    const table = await iconTable(["CraftingResources", "Consumables", "Fish", "Weapons"]);
    if (!table) {
      if (wiki) incomplete = true;
      return null;
    }
    if (table.size < 50) throw new Error(`only ${table.size} icons listed on the wiki`);
    const icons: Record<string, string> = {};
    const byFile = new Map<string, string | null>();
    for (const [name, file] of [...table].sort(([a], [b]) => a.localeCompare(b))) {
      if (!byFile.has(file)) {
        const s = slug(file);
        const avakot = `img/avakot/${s}.png`;
        byFile.set(file, (await exists(join(o.outDir, avakot))) || (await exists(join(o.bundledDir, avakot))) ? avakot : await icon("img/items", file));
      }
      const rel = byFile.get(file) ?? itemIcons[name];
      if (rel) icons[name] = rel;
    }
    itemIcons = icons;
    await put("itemicons.json", `${JSON.stringify(icons, null, 2)}\n`);
    return `${Object.keys(icons).length} item icons`;
  });

  await step("upgrades.json", async () => {
    const lua = wiki ? await wiki.wikitext("Module:Data/Runes") : null;
    const parsed = lua ? parseWikiRunes(lua).filter((r) => r.id) : [];
    const wikiRunes = parsed.length >= 10 ? new Map<string, WikiRune>(parsed.map((r) => [r.id!, r])) : null;
    if (!wikiRunes && wiki) incomplete = true;
    const prev = await previous<UpgradeData>("upgrades.json");
    const data = await buildUpgrades(dict, unique, wikiRunes, prev, itemIcons, (file) => icon("img/runes", file));
    enough("upgrades", Object.keys(data.runes).length + Object.keys(data.gear).length, prev ? Object.keys(prev.runes).length + Object.keys(prev.gear).length : undefined);
    const { missingIcons, ...upgrades } = data;
    await put("upgrades.json", `${JSON.stringify(upgrades, null, 2)}\n`);
    return `${Object.keys(upgrades.runes).length} runes, ${Object.keys(upgrades.joineries).length} joineries, ${Object.keys(upgrades.gear).length} gear`;
  });

  await step("avakot.json", async () => {
    const pool = buildAvakot(dict, unique, names.items);
    const prev = await previous<AvakotPool>("avakot.json");
    enough("Avakot's items", pool.items.length, prev?.items.length);
    const prevIcon = new Map((prev?.items ?? []).map((i) => [i.storeItem, i.icon]));
    const table = await iconTable(["CraftingResources", "Consumables", "Fish", "Misc", "Pacts"]);
    if (!table && wiki) incomplete = true;
    for (const it of pool.items) {
      if (it.group === "Joineries") {
        it.icon = `img/joineries/${it.name.split(":")[0]!.trim().toLowerCase()}.png`;
        continue;
      }
      const file = table?.get(it.name) ?? table?.get(/ of (.+ Lampyrite)$/.exec(it.name)?.[1] ?? "");
      it.icon = (file ? await icon("img/avakot", file) : null) ?? prevIcon.get(it.storeItem) ?? null;
    }
    if (table) for (const [file, as] of [["DracsCurrencyIcon.png", "dracs"], ["Arcs.png", "arcs"]] as const) await icon("img/avakot", file, as);
    await put("avakot.json", `${JSON.stringify(pool, null, 2)}\n`);
    return `${pool.items.length} Avakot items`;
  });

  await step("recipes.json", async () => {
    const recipes = buildRecipes(dict, unique, names.items);
    const prev = (await previous<{ recipes?: Record<string, RecipeDef> }>("recipes.json"))?.recipes;
    enough("recipes", Object.keys(recipes).length, prev ? Object.keys(prev).length : undefined);
    const lua = wiki ? await wiki.wikitext("Module:Data/CraftingTable") : null;
    const crafts = lua ? parseCraftingTable(lua) : null;
    const images = await imageTable(RECIPE_IMAGE_MODULES);
    if (wiki && (!crafts?.size || !images)) incomplete = true;
    for (const [type, r] of Object.entries(recipes)) {
      const old = prev?.[type];
      r.bond = crafts?.size ? (wikiEntry(crafts, r) ?? null) : (old?.bond ?? null);
      const file = images ? (wikiEntry(images, r) ?? images.get(r.name)) : undefined;
      r.icon = itemIcons[r.name] ?? (file ? await icon("img/items", file) : null) ?? old?.icon ?? null;
    }
    await put("recipes.json", `${JSON.stringify({ recipes }, null, 2)}\n`);
    return `${Object.keys(recipes).length} recipes`;
  });

  await step("faction-ranks.json", async () => {
    if (!wiki) return null;
    const prev = (await previous<Record<string, number[]>>("faction-ranks.json")) ?? {};
    const out: Record<string, number[]> = {};
    for (const [tag, page] of Object.entries(names.factions)) {
      const text = await wiki.wikitext(page);
      if (text === null) incomplete = true;
      const caps = (text ? parseFactionCaps(text) : null) ?? prev[tag];
      if (caps) out[tag] = caps;
    }
    out.default = out.SilentRoseSyndicate ?? DEFAULT_CAPS;
    await put("faction-ranks.json", JSON.stringify(out, null, 2));
    return `${Object.keys(out).length - 1} faction rank tables`;
  });

  const summary =
    `Game data: ${counts.join(", ")}` +
    (downloads ? `; ${downloads} new icons` : "") +
    (changed.length ? `; updated ${changed.join(", ")}` : "; nothing changed") +
    (failed.length ? `; kept the old ${failed.join(", ")}` : "") +
    ".";
  return { hash: files.hash, changed, failed, incomplete, downloads, summary };
}

export async function clearGameData(outDir: string): Promise<void> {
  for (const name of GAME_DATA_FILES) await rm(join(outDir, name), { force: true });
}
