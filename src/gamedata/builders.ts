import { matchArmourStem } from "./armour";
import type { Dict, TypeTree } from "./formats";

export function withRetired(fresh: Record<string, string>, previous: Record<string, string> | undefined): Record<string, string> {
  if (!previous) return fresh;
  const out = { ...fresh };
  for (const [key, value] of Object.entries(previous)) if (!(key in out)) out[key] = value;
  return out;
}

export interface NameData {
  items: Record<string, string>;
  factions: Record<string, string>;
  factionTokens: Record<string, string>;
  currencies: Record<string, string>;
}

const usable = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !v.startsWith("[PH]") && v !== "???";
const leafOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const field = (t: string, key: string): string | undefined => new RegExp(`^${key}=(.*)$`, "m").exec(t)?.[1];
export const sortedKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const FACTION_TAGS = ["ChampionSyndicate", "FeySyndicate", "OdeSyndicate", "SilentRoseSyndicate"];
const CURRENCY_FIELDS: Record<string, string> = {
  RegularCredits: "/SF/Language/Currency/CurrencyName",
  PremiumCredits: "/SF/Language/Currency/PremiumCurrencyName",
  PremiumCreditsFree: "/SF/Language/Currency/PremiumCurrencyName",
  FusionPoints: "/SF/Language/Currency/CurrencyMoteDustName",
};

function weaponAliases(stem: string): Set<string> {
  const out = new Set<string>();
  if (stem.endsWith("RangedMelee")) out.add(stem + "Weapon");
  if (stem.endsWith("Weapon") && !stem.endsWith("MeleeWeapon")) {
    const base = stem.slice(0, -"Weapon".length);
    out.add(base + "MeleeWeapon");
    out.add(base + "RangedMeleeWeapon");
  }
  if (stem.includes("Sword")) out.add(stem.replaceAll("Sword", "Swords"));
  return out;
}

export function buildNames(dict: Dict, tree: TypeTree): NameData {
  const factions: Record<string, string> = {};
  const factionTokens: Record<string, string> = {};
  for (const tag of FACTION_TAGS) {
    const name = dict[`/SF/Language/Syndicates/${tag.replace(/Syndicate$/, "")}Name`];
    if (name) factions[tag] = name;
    const token = dict[`/SF/Language/Syndicates/${tag}RepTokenName`];
    if (token) factionTokens[tag] = token;
  }
  const currencies: Record<string, string> = {};
  for (const [f, key] of Object.entries(CURRENCY_FIELDS)) {
    if (dict[key]) currencies[f] = dict[key];
  }
  const overrides: Record<string, string | undefined> = {
    FennJotarSwordMeleeWeapon: dict["/SF/Language/Weapons/FennJotarMeleeWeaponName"],
    WolfSoul: dict["/SF/Language/Pacts/OrengalName"],
    StagSoul: dict["/SF/Language/Pacts/GarrenName"],
    SecondaryOdeSawDaggerMeleeWeapon: dict["/SF/Language/Weapons/OdeSecondarySawSwordMeleeWeaponName"],
    HealRip: dict["/SF/Language/Motes/HealAoeRipName"],
    IronIngot: dict["/SF/Language/Materials/IronIgotName"],
  };

  const items: Record<string, string> = {};
  const setAlias = (key: string, value: string | undefined) => {
    if (key && value !== undefined && !(key in items)) items[key] = value;
  };
  const named = Object.entries(dict).filter(([k, v]) => typeof v === "string" && k.endsWith("Name") && v !== "" && !v.startsWith("[PH]"));
  for (const [key, value] of named) {
    const stem = key.slice(key.lastIndexOf("/") + 1, -"Name".length);
    if (stem && !(stem in items)) items[stem] = value;
  }
  for (const [key, value] of named) {
    const stem = key.slice(key.lastIndexOf("/") + 1, -"Name".length);
    if (key.startsWith("/SF/Language/Weapons/")) {
      for (const alias of weaponAliases(stem)) setAlias(alias, value);
    } else if (key.startsWith("/SF/Language/Pacts/")) {
      setAlias(stem + "Soul", value);
    }
  }

  const armourStems = Object.keys(dict)
    .filter((k) => k.startsWith("/SF/Language/Armour/") && k.endsWith("Name"))
    .map((k) => k.slice("/SF/Language/Armour/".length, -"Name".length));
  for (const path of tree.keys()) {
    const m = /^\/SF\/Upgrades\/Skins\/(Helmets|Body|Legs)\/(\w+)$/.exec(path);
    if (!m || m[2]! in items) continue;
    const stem = matchArmourStem(m[2]!, m[1]!, armourStems);
    const name = stem ? dict[`/SF/Language/Armour/${stem}Name`] : undefined;
    if (name && !name.startsWith("[PH]")) setAlias(m[2]!, name);
  }
  for (const path of tree.keys()) {
    const leaf = /^\/SF\/Upgrades\/Skins\/Helmets\/(Hair\d+AHelmet)$/.exec(path)?.[1];
    if (leaf) setAlias(leaf, dict["/SF/Language/Armour/NoHelmetName"]);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value) items[key] = value;
  }
  return { items, factions, factionTokens, currencies };
}

export interface EnemyData {
  names: Record<string, string>;
  parents: Record<string, string>;
}

export function buildEnemies(dict: Dict, tree: TypeTree): EnemyData {
  const parentOf = new Map<string, string>();
  for (const [path, parent] of tree) if (parent) parentOf.set(path, parent);
  if (parentOf.size === 0) throw new Error("no type tree in Packages.bin");

  const parents: Record<string, string> = {};
  for (const path of parentOf.keys()) {
    if (!path.startsWith("/SF/Types/Enemies/")) continue;
    for (let p = path, hops = 0; parentOf.has(p) && hops < 20; p = parentOf.get(p)!, hops += 1) {
      const leaf = leafOf(p);
      if (!(leaf in parents)) parents[leaf] = leafOf(parentOf.get(p)!);
    }
  }

  const names: Record<string, string> = {};
  const add = (leaf: string, value: unknown) => {
    const k = leaf.toLowerCase();
    if (usable(value) && !(k in names)) names[k] = value.trim();
  };
  const CODEX = "/SF/Language/Codex/";
  const TITLES = "/SF/Language/Titles/";
  const CHARACTERS = "/SF/Language/Characters/";
  for (const [k, v] of Object.entries(dict)) {
    if (k.startsWith(CODEX) && k.endsWith("AvatarName")) add(k.slice(CODEX.length, -"Name".length), v);
  }
  for (const [k, v] of Object.entries(dict)) {
    if (!k.startsWith(TITLES) || !k.endsWith("AvatarKillTitle_Req")) continue;
    const quoted = /"([^"]+)"/.exec(v);
    if (quoted) add(k.slice(TITLES.length, -"KillTitle_Req".length), quoted[1]);
  }
  const enemyLeaves = new Set(Object.keys(parents).map((l) => l.toLowerCase()));
  for (const [k, v] of Object.entries(dict)) {
    if (!k.startsWith(CHARACTERS)) continue;
    const leaf = k.slice(CHARACTERS.length) + "Avatar";
    if (enemyLeaves.has(leaf.toLowerCase())) add(leaf, v);
  }
  return { names: sortedKeys(names), parents: sortedKeys(parents) };
}

export interface LocationDef {
  name: string;
  memories: number;
  map: boolean;
}

const LORE_DIR = "/SF/Types/Quests/LocationLoreQuests/";

export function buildLocations(dict: Dict, tree: TypeTree, texts: string[]): { locations: Record<string, LocationDef>; skipped: string[] } {
  const types = [...tree.keys()].filter((p) => p.startsWith(LORE_DIR) && !p.slice(LORE_DIR.length).includes("/"));
  const stem = (s: string) => s.replace(/(Location)?(Map)?LoreFragment$/, "").replace(/Name$/, "").toLowerCase();
  const nameKey = (t: string) => /^Name=(\/SF\/Language\/Locations\/\S+)$/m.exec(t)?.[1];

  const votes = new Map<number, number>();
  const typesByStem = new Map<string, number[]>();
  types.forEach((p, j) => typesByStem.set(stem(leafOf(p)), [...(typesByStem.get(stem(leafOf(p))) ?? []), j]));
  texts.forEach((t, f) => {
    const key = nameKey(t);
    for (const j of key ? (typesByStem.get(stem(leafOf(key))) ?? []) : []) votes.set(f - j, (votes.get(f - j) ?? 0) + 1);
  });
  const [offset = 0, agree = 0] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (agree < types.length / 4) throw new Error(`only ${agree} of ${types.length} location types line up with their texts by name`);

  const locations: Record<string, LocationDef> = {};
  const skipped: string[] = [];
  for (const [j, path] of types.entries()) {
    const text = texts[j + offset] ?? "";
    const key = nameKey(text);
    const name = key ? dict[key]?.trim() : undefined;
    if (!name || name.startsWith("[PH]")) {
      if (key) skipped.push(leafOf(path));
      continue;
    }
    const memories = (/^Memories=\{\n([\s\S]*?)\n\}/m.exec(text)?.[1] ?? "").split("\n").filter((l) => l.trim()).length;
    locations[leafOf(path)] = { name, memories, map: /MapLoreFragment$/.test(leafOf(path)) };
  }
  return { locations, skipped };
}

export interface PactArtStat {
  n: number;
  unit: string;
  sign: boolean;
  label: string;
}

const WORDING: Record<string, { scale?: number; unit?: string; sign?: boolean; label: string }> = {
  PREVENT_DEATH_SKILL_CHANCE: { scale: 100, unit: "%", label: "chance to survive a killing blow" },
  PREVENT_DEATH_SKILL_HEAL: { label: "Health restored when it saves you" },
  PREVENT_STABILITY_BREAK_SKILL_CHANCE: { scale: 100, unit: "%", label: "chance to resist being knocked down" },
  AVATAR_HEALTH_MAX: { sign: true, label: "max Health" },
  AVATAR_STABILITY_MAX: { sign: true, label: "max Stability" },
  AVATAR_RESPAWN_TIME: { sign: true, scale: 100, unit: "%", label: "time before you're revived at a Revive Shrine" },
  GAMEPLAY_GEAR_ITEM_MAXSTACK: { sign: true, label: "Life Elixir capacity" },
  GAMEPLAY_POWER_COOLDOWN: { sign: true, scale: 100, unit: "%", label: "ability cooldown" },
};

export function buildPactArtValues(dict: Dict, texts: string[], arts: Record<string, { name: string; virtue?: unknown }>): Record<string, PactArtStat[]> {
  const statsByName = new Map<string, PactArtStat[]>();
  for (const t of texts) {
    const tag = /^LocalizeTag=(\/SF\/Language\/Pacts\/\S+)$/m.exec(t)?.[1];
    if (!tag || !/^FusionLimit=/m.test(t) || !/^Upgrades=\{/m.test(t)) continue;
    const name = dict[tag]?.trim();
    if (!name) continue;
    const stats: PactArtStat[] = [];
    for (const [, type, value, filter] of t.matchAll(/UpgradeType=(\S+)\nOperationType=\S+\nValue=(\S+)[\s\S]*?SymbolFilter=(\S*)/g)) {
      const stat = filter && filter !== '""' ? filter : type!;
      const w = WORDING[stat];
      if (!w) continue;
      const n = Number((Number(value) * (w.scale ?? 1)).toFixed(4));
      stats.push({ n: w.sign ? n : Math.abs(n), unit: w.unit ?? "", sign: !!w.sign, label: w.label });
    }
    if (stats.length) statsByName.set(name, stats);
  }
  const out: Record<string, PactArtStat[]> = {};
  for (const [key, def] of Object.entries(arts)) {
    if (def.virtue) continue;
    const stats = statsByName.get(def.name);
    if (stats) out[key] = stats;
  }
  return out;
}

export interface AvakotItem {
  storeItem: string;
  name: string;
  group: string;
  kind: "always" | "weekly" | "rotating";
  currency: "Dracs" | "Arcs" | null;
  price: [number, number] | null;
  hours: [number, number] | null;
  weight: number;
  limit: number | null;
  icon: string | null;
}

export interface AvakotPool {
  vendor: string;
  slots: number | null;
  items: AvakotItem[];
}

export const AVAKOT_VENDOR = "/SF/Types/Game/AvakotVendorManifest";
const AVAKOT_GROUPS: [RegExp, string][] = [
  [/\/Consumables\/Tackle\//, "Lures"],
  [/\/Resources\/Bundles\/Catalysts\//, "Lampyrite"],
  [/\/Kintsugi\//, "Joineries"],
  [/\/Recipes\/Pacts\//, "Pact Fragments"],
  [/\/PickUps\/Resources\//, "Materials"],
  [/\/Consumables\//, "Supplies"],
];

const pair = (s: string | undefined): [number, number] | null => {
  const m = /^\{(-?[\d.]+),(-?[\d.]+)\}$/.exec(s ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
};

export function buildAvakot(dict: Dict, texts: string[], names: Record<string, string>): AvakotPool {
  const manifests = texts.filter((t) => t.includes("ItemManifest={") && t.includes("NumItemsAvailable=") && t.includes("/Consumables/Tackle/"));
  if (manifests.length !== 1) throw new Error(`expected one Avakot vendor manifest, found ${manifests.length}`);
  const manifest = manifests[0]!;

  const tagOf = new Map<string, string>();
  for (const t of texts) {
    const type = /^TypeName=(\S+)$/m.exec(t)?.[1];
    const tag = /^LocalizeTag=(\S+)$/m.exec(t)?.[1];
    if (type && tag && !tagOf.has(type)) tagOf.set(type, tag);
  }
  const nameOf = (storeItem: string): string => {
    const type = storeItem.replace("/SF/StoreItems/", "/SF/");
    const tag = tagOf.get(type);
    const fromTag = tag ? dict[tag] : undefined;
    if (usable(fromTag)) return fromTag.trim();
    const leaf = leafOf(storeItem);
    return names[type] ?? names[leaf] ?? leaf.replace(/([a-z])([A-Z])/g, "$1 $2");
  };

  const items: AvakotItem[] = [];
  for (const [, storeItem, block] of manifest.matchAll(/\{\nStoreItem=([^\n]+)\n([\s\S]*?)\nIncreasePerNegativeRank=[^\n]*\n\}/g)) {
    const regular = pair(field(block!, "RegularPrice"));
    const premium = pair(field(block!, "PremiumPrice"));
    const [currency, price]: [AvakotItem["currency"], AvakotItem["price"]] =
      regular && regular[1] > 0 ? ["Dracs", regular] : premium && premium[1] > 0 ? ["Arcs", premium] : [null, null];
    const limit = Number(field(block!, "PurchaseQuantityLimit"));
    items.push({
      storeItem: storeItem!,
      name: nameOf(storeItem!),
      group: AVAKOT_GROUPS.find(([re]) => re.test(storeItem!))?.[1] ?? "Other",
      kind: field(block!, "AlwaysOffered") === "1" ? "always" : field(block!, "RotatedWeekly") === "1" ? "weekly" : "rotating",
      currency,
      price,
      hours: pair(field(block!, "DurationAvailable")),
      weight: Number(Number(field(block!, "AppearanceFrequency")).toFixed(3)),
      limit: limit > 0 ? limit : null,
      icon: null,
    });
  }
  if (items.length < 10) throw new Error(`Avakot manifest: only ${items.length} items parsed`);
  const slots = pair(field(manifest, "NumItemsAvailable"));
  return { vendor: AVAKOT_VENDOR, slots: slots ? slots[1] : null, items };
}

export interface WikiRune {
  name: string;
  id: string | null;
  icon: string | null;
  art: string | null;
  does: string | null;
  slot: string | null;
  stats: { effect: string; values: string[] }[];
}

export function parseWikiRunes(lua: string): WikiRune[] {
  const out: WikiRune[] = [];
  for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\s*\},?\s*\n/g)) {
    const body = m[2]!;
    const str = (k: string) => new RegExp(`\\b${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body)?.[1]?.replace(/\\"/g, '"') ?? null;
    const stats = [...body.matchAll(/\{\s*Effect\s*=\s*"((?:[^"\\]|\\.)*)"\s*,\s*Ranks\s*=\s*"([^"]*)"\s*\}/g)].map((s) => ({
      effect: s[1]!.replace(/\\"/g, '"'),
      values: s[2]!.split("/").map((v) => v.trim()),
    }));
    out.push({ name: m[1]!, id: str("InternalID"), icon: str("ImgIcon"), art: str("WeaponArt"), does: str("Functionality"), slot: str("AddedSlot"), stats });
  }
  return out;
}

export function parseWikiIcons(lua: string, into: Map<string, string>): void {
  for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\s*\},/g)) {
    const file = /\b(?:Img)?(?:Icon|Image)\s*=\s*"([^"]+\.png)"/.exec(m[2]!)?.[1];
    if (file && !into.has(m[1]!)) into.set(m[1]!, file);
  }
}

export interface RuneEntry {
  name: string;
  desc: string | null;
  art: string | null;
  does: string | null;
  slot: string | null;
  stats: WikiRune["stats"];
  icon: string | null;
}

export interface JoineryEntry {
  name: string;
  family: string | null;
  desc: string | null;
  rarity: string | null;
  icon: string;
}

export interface GearEntry {
  name: string;
  desc: string | null;
  kind: "Fishing" | "Companion" | "Supplies";
  icon: string | null;
}

export interface UpgradeData {
  runes: Record<string, RuneEntry>;
  joineries: Record<string, JoineryEntry>;
  gear: Record<string, GearEntry>;
}

const JOINERY_FAMILIES = ["Verite", "Quicksilver", "Feybalt", "Gildaur"];

export async function buildUpgrades(
  dict: Dict,
  texts: string[],
  wikiRunes: Map<string, WikiRune> | null,
  previous: UpgradeData | null,
  itemIcons: Record<string, string>,
  runeIcon: (file: string) => Promise<string | null>,
): Promise<UpgradeData & { missingIcons: string[] }> {
  const loc = (tag: string | undefined) => (tag && usable(dict[tag]) ? dict[tag]!.trim().replace(/\s+/g, " ") : null);
  const searchTags = (t: string) =>
    (/^SearchTags=\{\n([\s\S]*?)\n\}/m.exec(t)?.[1] ?? "").split("\n").map((x) => loc(x.replace(/,$/, ""))).filter((x): x is string => !!x);

  const items = new Map<string, { t: string; cat: string; name: string }>();
  for (const t of texts) {
    const type = field(t, "TypeName");
    const cat = field(t, "ProductCategory");
    const name = loc(field(t, "LocalizeTag"));
    if (!type || !cat || !name || items.has(type)) continue;
    items.set(type, { t, cat, name });
  }

  const runes: Record<string, RuneEntry> = {};
  const missingIcons: string[] = [];
  for (const [type, { t, cat, name }] of items) {
    if (cat !== "Upgrades" || !type.startsWith("/SF/Upgrades/Runes/Weapon/")) continue;
    const w = wikiRunes?.get(type);
    const prev = wikiRunes ? undefined : previous?.runes[type];
    const iconFile = w?.icon ?? field(t, "Icon")?.split("/").pop() ?? null;
    const icon = prev?.icon ?? (iconFile ? await runeIcon(iconFile) : null);
    if (iconFile && !icon) missingIcons.push(name);
    runes[type] = {
      name,
      desc: loc(field(t, "LocalizeDescTag")),
      art: searchTags(t)[0] ?? w?.art ?? prev?.art ?? null,
      does: w?.does ?? prev?.does ?? null,
      slot: w?.slot ?? prev?.slot ?? null,
      stats: w?.stats ?? prev?.stats ?? [],
      icon,
    };
  }

  const joineries: Record<string, JoineryEntry> = {};
  for (const [type, { t, cat, name }] of items) {
    if (cat !== "Upgrades" || !type.startsWith("/SF/Types/Items/Kintsugi/")) continue;
    const family = JOINERY_FAMILIES.find((f) => name.startsWith(`${f}:`)) ?? null;
    joineries[type] = {
      name,
      family,
      desc: loc(field(t, "LocalizeDescTag")),
      rarity: field(t, "Rarity") ?? null,
      icon: `img/joineries/${family ? family.toLowerCase() : "joinery"}.png`,
    };
  }

  const iconByName = new Map<string, string>();
  for (const [k, v] of Object.entries(itemIcons)) {
    iconByName.set(k, v);
    const base = k.replace(/\s*\([^)]*\)$/, "");
    if (!iconByName.has(base)) iconByName.set(base, v);
  }
  const gear: Record<string, GearEntry> = {};
  for (const [type, { t, cat, name }] of items) {
    if (cat !== "Consumables" || !type.startsWith("/SF/Types/Items/Consumables/")) continue;
    gear[type] = {
      name,
      desc: loc(field(t, "LocalizeDescTag")),
      kind: type.includes("/Tackle/") || type.includes("FishingSpool") ? "Fishing" : type.includes("/PetConsumeables/") || type.includes("PetFood") ? "Companion" : "Supplies",
      icon: iconByName.get(name) ?? null,
    };
  }

  return { runes: sortedKeys(runes), joineries: sortedKeys(joineries), gear: sortedKeys(gear), missingIcons };
}

export function parseFactionCaps(text: string): number[] | null {
  const caps: number[] = [];
  const re = /^\|\s*(\d)\s*\|\|.*?FactionStanding\.png[^\]]*\]\]\s*'*([\d,]+)/gm;
  for (let m; (m = re.exec(text)) !== null; ) caps[Number(m[1])] = Number(m[2]!.replaceAll(",", ""));
  return caps.length && caps.every((c) => typeof c === "number") ? caps : null;
}

export interface RecipeIngredient {
  type: string;
  name: string;
  count: number;
  alt?: string[];
}

export interface RecipeDef {
  name: string;
  station: "Blacksmith" | "Brewing";
  kind: string;
  result: string;
  rarity: string | null;
  fragments: number;
  consumed: boolean;
  gives: number;
  dracs: number;
  seconds: number;
  ingredients: RecipeIngredient[];
  desc: string | null;
  icon: string | null;
  bond: number | null;
}

const RECIPES = "/SF/Types/Recipes/";
const NOT_CRAFTS = /^(WeaponQuality|WeaponAspectManipulation|WeaponTitles)(\/|$)|ReforgeBlueprint$/;

export function recipeKind(type: string, name: string): [RecipeDef["station"], string] | null {
  const folder = type.slice(RECIPES.length, type.lastIndexOf("/"));
  if (NOT_CRAFTS.test(folder)) return null;
  const top = folder.split("/")[0];
  if (top === "Elixers") return ["Brewing", "Elixirs"];
  if (top === "ColorPalettes") return ["Brewing", "Palettes"];
  if (top === "Consumeables") return ["Brewing", "Pup Treats"];
  if ((top === "Ingots" || top === "Quests") && /Chordstone/.test(name)) return ["Blacksmith", "Chordstones"];
  return null;
}

export function buildRecipes(dict: Dict, texts: string[], names: Record<string, string>): Record<string, RecipeDef> {
  const tagOf = new Map<string, string>();
  const descOf = new Map<string, string>();
  for (const t of texts) {
    const type = /^TypeName=(\S+)$/m.exec(t)?.[1];
    const tag = /^LocalizeTag=(\S+)$/m.exec(t)?.[1];
    const desc = /^LocalizeDescTag=(\S+)$/m.exec(t)?.[1];
    if (type && tag && !tagOf.has(type)) tagOf.set(type, tag);
    if (type && desc && !descOf.has(type)) descOf.set(type, desc);
  }
  const text = (tag: string | undefined): string | null => (tag && usable(dict[tag]) ? dict[tag]!.replace(/\r\n?/g, "\n").trim() : null);
  const itemName = (type: string): string => {
    const tag = tagOf.get(type);
    const own = tag ? dict[tag] : undefined;
    if (usable(own)) return own.trim();
    const leaf = leafOf(type);
    for (const k of [type, leaf, leaf.replace(/Item$/, ""), leaf.replace(/(Resource)?(Item)?$/, "")]) if (names[k]) return names[k]!;
    return leaf.replace(/(Resource)?(Item)?$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  };

  const out: Record<string, RecipeDef> = {};
  for (const t of texts) {
    const type = field(t, "TypeName");
    if (!type?.startsWith(RECIPES) || type in out) continue;
    const result = field(t, "ResultItem");
    if (!result) continue;
    const tag = field(t, "OverrideLocalizeTag") ?? field(t, "LocalizeTag");
    const name = (tag && usable(dict[tag]) ? dict[tag]!.trim() : null) ?? itemName(result.replace("/SF/StoreItems/", "/SF/"));
    const kind = recipeKind(type, name);
    if (!kind) continue;
    const ingredients: RecipeIngredient[] = [];
    for (const [, ing, alts, count] of t.matchAll(/\{\nItemType=(\S+)\nAlternativeItemTypes=\{([^}]*)\}\nItemCount=(\d+)/g)) {
      const alt = alts!.split(/[\n,]+/).map((a) => a.trim()).filter((a) => a.startsWith("/"));
      ingredients.push({ type: ing!, name: itemName(ing!), count: Number(count), ...(alt.length ? { alt } : {}) });
    }
    if (!ingredients.length) continue;
    const made = result.replace("/SF/StoreItems/", "/SF/");
    const gives = Math.max(1, Number(field(t, "NumToGive") ?? 1));
    out[type] = {
      name,
      station: kind[0],
      kind: kind[1],
      result: made,
      rarity: field(t, "Rarity") ?? null,
      fragments: Math.max(1, Number(field(t, "NumRequired") ?? 1)),
      consumed: field(t, "ConsumeOnUse") !== "0",
      gives,
      dracs: Number(field(t, "BuildPrice") ?? 0),
      seconds: Number(field(t, "BuildTime") ?? 0),
      ingredients,
      desc: (text(field(t, "LocalizeDescTag")) ?? text(descOf.get(made)))?.replaceAll("|AMOUNT|", String(gives)) ?? null,
      icon: null,
      bond: null,
    };
  }
  return sortedKeys(out);
}

export function parseCraftingTable(lua: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\s*Ingredients\s*=/g)) {
    const bond = /\bBondReq\s*=\s*"(\d+)"/.exec(m[2]!)?.[1];
    out.set(m[1]!.trim(), bond ? Number(bond) : null);
  }
  return out;
}

export function parseWikiImages(lua: string, into: Map<string, string>): void {
  for (const m of lua.matchAll(/\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\s*\},/g)) {
    const file = /\b(?:Img)?(?:Icon|Image|Preview)\s*=\s*"([^"]+\.png)"/.exec(m[2]!)?.[1];
    if (file && !into.has(m[1]!.trim())) into.set(m[1]!.trim(), file);
  }
}
