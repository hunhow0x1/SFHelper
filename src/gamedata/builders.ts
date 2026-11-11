import { matchArmourStem } from "./armour";
import type { Dict, TypeTree } from "./formats";
import { isGear } from "../server/upgradeItems";

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
  tokenLimits: Record<string, number>;
  currencies: Record<string, string>;
  pets: PetText;
  crafting: Record<string, string>;
  founders: string[];
}

export function buildFounderItems(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!/^MarketSubcategoryOverride=founders$/m.test(t)) continue;
    const parts = t.split(/^PackageComponents=\{$/m)[1];
    if (!parts) continue;
    for (const [, type] of parts.matchAll(/^TypeName=(\S+)$/gm)) {
      if (type!.startsWith("/SF/StoreItems/")) out.add(type!.replace("/SF/StoreItems/", "/SF/"));
    }
  }
  return [...out].sort();
}

export function factionIconPaths(texts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of texts) {
    const stem = /^SyndicateName=\/SF\/Language\/Syndicates\/(\w+)Name$/m.exec(t)?.[1];
    const icon = /^IconTexture=(\S+\.png)$/m.exec(t)?.[1];
    const tag = stem ? `${stem}Syndicate` : null;
    if (tag && icon && FACTION_TAGS.includes(tag) && !out[tag]) out[tag] = icon;
  }
  return sortedKeys(out);
}

const CRAFTING_LABELS: Record<string, string> = {
  readyToClaim: "Foundry_ReadyToClaimHeader",
  inProgress: "Foundry_InProgressHeader",
  nothingToClaim: "NothingToClaim",
  curingTime: "Foundry_CuringTimeTitle",
};

export function buildCraftingText(dict: Dict): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, key] of Object.entries(CRAFTING_LABELS)) {
    const text = dict[`/SF/Language/Crafting/${key}`];
    if (usable(text)) out[label] = text.trim();
  }
  return out;
}

export interface PetText {
  names: Record<string, string>;
  temperaments: Record<string, string>;
  stats: Record<string, string>;
  labels: Record<string, string>;
  limits: { training: number; skill: number; meals: number; snacks: number; energy: number } | null;
}

const PET_LABELS: Record<string, string> = {
  temperament: "PetStat_Temperament",
  training: "PetStat_Maturity",
  trainingComplete: "PetStat_MaxMaturity",
  bond: "PetStat_Bond",
  energy: "PetStat_Energy",
};

export function buildPetText(dict: Dict, texts: string[]): PetText {
  const pick = (key: string) => (usable(dict[key]) ? dict[key]!.trim() : undefined);
  const names: Record<string, string> = {};
  const temperaments: Record<string, string> = {};
  const stats: Record<string, string> = {};
  const labels: Record<string, string> = {};
  let limits: PetText["limits"] = null;
  for (const t of texts) {
    const defaults = /^DefaultPetStats=\{\n([\s\S]*?)\n\}/m.exec(t)?.[1];
    const tag = defaults ? field(defaults, "Name") : undefined;
    const name = tag ? pick(tag) : undefined;
    if (tag && name) names[tag] = name;
    const training = Number(field(t, "MaxMaturity"));
    if (!limits && training > 0) {
      const skill = Math.max(...["Guard", "Speed", "Stamina", "Search", "Support"].map((s) => Number(field(t, `Max${s}Skill`)) || 0));
      limits = {
        training,
        skill,
        meals: Number(field(t, "MaxMealsToBeOverfed")) || 0,
        snacks: Number(field(t, "SnackOverfed")) || 0,
        energy: Number(field(t, "MaxEnergy")) || 0,
      };
    }
  }
  for (const key of Object.keys(dict)) {
    const temper = /^\/SF\/Language\/Pets\/PetTemperment_(\w+)$/.exec(key)?.[1];
    if (temper && pick(key)) temperaments[`TEMPERMENT_${temper.toUpperCase()}`] = pick(key)!;
    const stat = /^\/SF\/Language\/Pets\/PetStat_(Guard|Speed|Stamina|Search|Support)$/.exec(key)?.[1];
    if (stat && pick(key)) stats[stat] = pick(key)!;
  }
  for (const [label, key] of Object.entries(PET_LABELS)) {
    const text = pick(`/SF/Language/Pets/${key}`);
    if (text) labels[label] = text;
  }
  return { names: sortedKeys(names), temperaments: sortedKeys(temperaments), stats, labels, limits };
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

const TOKEN_TYPE_RE = /^\/SF\/Types\/Items\/FactionItems\/(\w+)RepToken$/;
const ANCESTOR_RE = /^\/SF\/Types\/Npcs\/BoonNPC\/(\w+)BoonNpc$/;
const NPC_NAME_RE = /^_npcName=(\S+)$/m;

function ancestorName(dict: Dict, texts: string[], stem: string): string | undefined {
  const own = dict[`/SF/Language/Characters/${stem}`];
  if (own) return own;
  const key = texts.find((t) => t.includes(`\n_npcTag=${stem}Npc\n`) || t.endsWith(`\n_npcTag=${stem}Npc`))?.match(NPC_NAME_RE)?.[1];
  return key ? dict[key] : undefined;
}

export function buildNames(dict: Dict, tree: TypeTree, texts: string[] = []): NameData {
  const factions: Record<string, string> = {};
  const factionTokens: Record<string, string> = {};
  for (const tag of FACTION_TAGS) {
    const name = dict[`/SF/Language/Syndicates/${tag.replace(/Syndicate$/, "")}Name`];
    if (name) factions[tag] = name;
    const token = dict[`/SF/Language/Syndicates/${tag}RepTokenName`];
    if (token) factionTokens[tag] = token;
  }
  const tokenLimits: Record<string, number> = {};
  for (const t of texts) {
    const tag = TOKEN_TYPE_RE.exec(field(t, "TypeName") ?? "")?.[1];
    const size = tag ? Number(field(t, "StackSize")) : 0;
    if (tag && size > 0) tokenLimits[tag] = size;
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
  for (const path of tree.keys()) {
    const stem = ANCESTOR_RE.exec(path)?.[1];
    if (stem) setAlias(`${stem}BoonNpc`, ancestorName(dict, texts, stem));
  }
  const arsenal = buildArsenal(dict, texts);
  for (const [type, w] of Object.entries(arsenal.weapons)) items[leafOf(type)] = w.name;
  for (const [type, name] of Object.entries(arsenal.pacts)) items[leafOf(type)] = name;
  for (const t of texts) {
    const type = field(t, "TypeName");
    const name = type?.startsWith("/SF/Upgrades/Runes/Weapon/") && field(t, "ProductCategory") === "Upgrades" ? localized(dict, field(t, "LocalizeTag")) : null;
    if (type && name && !(type in items)) items[type] = name;
  }
  return { items, factions, factionTokens, tokenLimits, currencies, pets: buildPetText(dict, texts), crafting: buildCraftingText(dict), founders: buildFounderItems(texts) };
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
  const byWords = new Map<string, string | null>();
  const add = (leaf: string, value: unknown) => {
    const k = leaf.toLowerCase();
    if (!usable(value) || k in names) return;
    names[k] = value.trim();
    const w = wordKey(leaf);
    byWords.set(w, byWords.has(w) && byWords.get(w) !== names[k] ? null : names[k]);
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
  for (const leaf of Object.keys(parents)) {
    if (!leaf.endsWith("Avatar") || leaf.toLowerCase() in names) continue;
    const name = byWords.get(wordKey(leaf));
    if (name) names[leaf.toLowerCase()] = name;
  }
  return { names: sortedKeys(names), parents: sortedKeys(parents) };
}

const wordKey = (leaf: string): string =>
  (leaf.replace(/SubBoss/g, "Subboss").match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? []).map((w) => w.toLowerCase()).sort().join(" ");

export interface LocationDef {
  name: string;
  memories: number;
  map: boolean;
}

const LORE_DIR = "/SF/Types/Quests/LocationLoreQuests/";

export function buildDungeons(dict: Dict): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    const stem = /^\/SF\/Language\/Locations\/(\w+)DungeonMapName$/.exec(key)?.[1];
    const name = typeof value === "string" ? value.trim() : "";
    if (stem && name && !name.startsWith("[PH]")) out[stem] = name;
  }
  return sortedKeys(out);
}

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
  text: string | null;
  vals: Record<string, string[]> | null;
  art: string | null;
  does: string | null;
  slot: string | null;
  stats: WikiRune["stats"];
  icon: string | null;
  tags?: string[];
  drops?: RuneDrops;
}

export interface RuneDropBoss {
  name: string;
  icon?: string;
  cogah?: boolean;
}

export interface RuneDrops {
  bosses?: RuneDropBoss[];
  sieges?: string[];
  votives?: string[];
  chests?: string[];
}

export interface WikiDropTable {
  key: string;
  tags: string;
  sources: string[];
  drops: string[];
}

export function parseDropTables(lua: string): WikiDropTable[] {
  const out: WikiDropTable[] = [];
  const starts = [...lua.matchAll(/\n\s*\["([^"]+)"\]\s*=\s*\{/g)];
  for (const [i, m] of starts.entries()) {
    const body = lua.slice(m.index! + m[0].length, starts[i + 1]?.index ?? lua.length);
    const at = body.search(/\bDrops\s*=/);
    if (at < 0) continue;
    const names = (text: string) => [...text.matchAll(/\bName\s*=\s*"([^"]+)"/g)].map((x) => x[1]!.trim());
    out.push({ key: m[1]!, tags: /\bTags\s*=\s*"([^"]*)"/.exec(body)?.[1] ?? "", sources: names(body.slice(0, at)), drops: names(body.slice(at)) });
  }
  return out;
}

const CODEX_ICONS = "/SF/Interface/Graphics/StoreItems/Codex/";
const looseName = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");

export function bossPortraits(texts: string[], enemies: EnemyData): Map<string, { name: string; icon: string | null }> {
  const icons = new Map<string, string>();
  for (const t of texts) {
    const tag = /^LocTag=\/SF\/Language\/Codex\/(\w+Avatar)Name$/m.exec(t)?.[1];
    const icon = field(t, "Icon");
    if (tag && icon?.startsWith(CODEX_ICONS) && !icons.has(tag.toLowerCase())) icons.set(tag.toLowerCase(), icon);
  }
  const leafOf = new Map(Object.keys(enemies.parents).map((leaf) => [leaf.toLowerCase(), leaf]));
  const iconFor = (key: string): string | null => {
    let leaf = leafOf.get(key);
    for (let hops = 0; hops < 12; hops += 1) {
      const own = icons.get(leaf ? leaf.toLowerCase() : key);
      if (own) return own;
      leaf = leaf ? enemies.parents[leaf] : undefined;
      if (!leaf) return null;
    }
    return null;
  };
  const out = new Map<string, { name: string; icon: string | null }>();
  for (const [key, name] of Object.entries(enemies.names)) {
    const k = looseName(name);
    const icon = iconFor(key);
    if (!out.has(k) || (icon && !out.get(k)!.icon)) out.set(k, { name, icon });
  }
  return out;
}

export function runeDrops(tables: WikiDropTable[], runeNames: Record<string, string>, bosses: Map<string, { name: string; icon: string | null }>): Record<string, RuneDrops> {
  const byName = new Map(Object.entries(runeNames).map(([type, name]) => [name, type]));
  const found = new Map<string, { bosses: Map<string, RuneDropBoss>; sieges: Set<string>; votives: Set<string>; chests: Set<string> }>();
  const place = (name: string) => name.replace(/#/g, " ").replace(/\s+Reward Manifest$/i, "").replace(/\s+/g, " ").trim();
  for (const t of tables) {
    const kind = t.tags === "Foes" ? "bosses" : /SiegeMissionReward/i.test(t.key) ? "sieges" : /Votive|FeyRelic/i.test(t.key) ? "votives" : t.tags === "Containers" ? "chests" : null;
    if (!kind) continue;
    for (const drop of t.drops) {
      const type = byName.get(drop);
      if (!type) continue;
      const r = found.get(type) ?? found.set(type, { bosses: new Map(), sieges: new Set(), votives: new Set(), chests: new Set() }).get(type)!;
      for (const source of t.sources) {
        if (kind !== "bosses") {
          r[kind].add(place(source));
          continue;
        }
        const cogah = /\(Cogah\)$/i.test(source) || /Rednight/i.test(t.key);
        const base = source.replace(/\s*\(Cogah\)$/i, "").trim();
        const game = bosses.get(looseName(base)) ?? bosses.get(looseName(base.replace(/^The\s+/i, "")));
        const name = game?.name ?? base;
        const key = `${cogah ? 1 : 0}${looseName(name)}`;
        if (!r.bosses.has(key)) r.bosses.set(key, { name, ...(game?.icon ? { icon: game.icon } : {}), ...(cogah ? { cogah: true } : {}) });
      }
    }
  }
  const out: Record<string, RuneDrops> = {};
  const sorted = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b));
  for (const [type, r] of found) {
    const bossList = [...r.bosses.values()].sort((a, b) => Number(!!a.cogah) - Number(!!b.cogah) || a.name.localeCompare(b.name));
    const d: RuneDrops = {};
    if (bossList.length) d.bosses = bossList;
    for (const k of ["sieges", "votives", "chests"] as const) if (r[k].size) d[k] = sorted(r[k]);
    out[type] = d;
  }
  return out;
}

export function parseRuneTags(lua: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const block of lua.split(/\n\s*\["/)) {
    const id = /\bInternalID\s*=\s*"([^"]+)"/.exec(block)?.[1];
    const tags = /\bTags\s*=\s*"([^"]*)"/.exec(block)?.[1];
    if (id) out.set(id, (tags ?? "").split(/\s*[,;]\s*/).filter(Boolean));
  }
  return out;
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
  virtue?: string;
  habitat?: string[];
  natures?: string[];
}

const FISH_NATURES = [
  "SFF_SURFACE_FEEDER",
  "SFF_AMBUSH_FEEDER",
  "SFF_BOTTOM_FEEDER",
  "SFF_MORNING_FEEDER",
  "SFF_DAY_FEEDER",
  "SFF_EVENING_FEEDER",
  "SFF_NIGHT_FEEDER",
  "SFF_RAIN_DWELLER",
  "SFF_OVERCAST_DWELLER",
  "SFF_WINDY_DWELLER",
  "SFF_LIGHTNING_DWELLER",
];
const listField = (t: string | undefined, key: string): string[] =>
  (new RegExp(`^${key}=\\{\\n([\\s\\S]*?)\\n\\}`, "m").exec(t ?? "")?.[1] ?? "").split("\n").map((x) => x.replace(/,$/, "").trim()).filter(Boolean);

export interface UpgradeData {
  runes: Record<string, RuneEntry>;
  joineries: Record<string, JoineryEntry>;
  gear: Record<string, GearEntry>;
}

const JOINERY_FAMILIES = ["Verite", "Quicksilver", "Feybalt", "Gildaur"];
const COMPANION_GEAR = /\/PetConsumeables\/|PetFood/;
const localized = (dict: Dict, tag: string | undefined): string | null => (tag && usable(dict[tag]) ? dict[tag]!.trim().replace(/\s+/g, " ") : null);

export interface ArsenalWeapon {
  name: string;
  slot: "Primary" | "Sidearm";
  style: string | null;
  damage: string | null;
}

export interface ArsenalData {
  patch?: string;
  weapons: Record<string, ArsenalWeapon>;
  pacts: Record<string, string>;
}

export function gamePatch(dict: Dict): string | null {
  const n = /\bPreludes\s+(\d+(?:\.\d+)?)/i.exec(dict["/SF/Language/Updates/TitleText"] ?? "")?.[1];
  return n ? `P${n}` : null;
}

const WEAPON_SLOTS: Record<string, ArsenalWeapon["slot"]> = { Melee: "Primary", LongGuns: "Sidearm", Pistols: "Sidearm" };

export function buildArsenal(dict: Dict, texts: string[]): ArsenalData {
  const weapons: Record<string, ArsenalWeapon> = {};
  const pacts: Record<string, string> = {};
  for (const t of texts) {
    const type = field(t, "TypeName");
    const cat = field(t, "ProductCategory");
    const name = localized(dict, field(t, "LocalizeTag"));
    if (!type || !cat || !name || field(t, "ExcludeFromCodex") === "1" || type in weapons || type in pacts) continue;
    const slot = WEAPON_SLOTS[cat];
    if (slot && type.startsWith("/SF/Weapons/")) {
      const tags = /^SearchTags=\{\n([\s\S]*?)\n\}/m.exec(t)?.[1] ?? "";
      weapons[type] = { name, slot, style: field(t, "MeleeStyle") ?? null, damage: /\/DT_([A-Z]+)/.exec(tags)?.[1] ?? null };
    } else if (cat === "Suits" && type.startsWith("/SF/Souls/")) {
      pacts[type] = name;
    }
  }
  const patch = gamePatch(dict);
  return { ...(patch ? { patch } : {}), weapons: sortedKeys(weapons), pacts: sortedKeys(pacts) };
}

const RUNE_SLOTS: Record<string, string> = { AP_ATTACK: "Courage", AP_DEFENSE: "Spirit", AP_TACTIC: "Grace" };
const STAT_RULES: [RegExp, RegExp][] = [
  [/^DURATION$/, /duration/i],
  [/^HEAL$/, /heal/i],
  [/^HEALTH$/, /health/i],
  [/^STAGGER$/, /stagger/i],
  [/^AREADAMAGE$/, /explosion/i],
  [/^DAMAGEMULT$/, /damage taken/i],
  [/^DAMAGE$/, /damage/i],
];

export function mergeRuneValues(template: string | null, game: Record<string, string[]> | null, wiki: Record<string, string[]> | null): Record<string, string[]> | null {
  if (!template || (!game && !wiki)) return null;
  const out: Record<string, string[]> = {};
  for (const name of new Set([...template.matchAll(/\|(\w+)\|/g)].map((m) => m[1]!))) {
    const v = game?.[name] ?? wiki?.[name];
    if (!v) return null;
    out[name] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function runeValues(template: string | null, stats: WikiRune["stats"]): Record<string, string[]> | null {
  if (!template) return null;
  const names = [...new Set([...template.matchAll(/\|(\w+)\|/g)].map((m) => m[1]!))];
  if (!names.length || names.length !== stats.length) return null;
  const left = stats.map((_, i) => i);
  const picked = new Map<string, number>();
  const take = (name: string, i: number) => {
    picked.set(name, i);
    left.splice(left.indexOf(i), 1);
  };
  for (const [placeholder, label] of STAT_RULES) {
    for (const name of names) {
      if (picked.has(name) || !placeholder.test(name)) continue;
      const i = left.find((j) => label.test(stats[j]!.effect));
      if (i !== undefined) take(name, i);
    }
  }
  for (const name of names) if (!picked.has(name) && left.length) take(name, left[0]!);
  if (picked.size !== names.length) return null;
  const out: Record<string, string[]> = {};
  for (const name of names) {
    const after = template.slice(template.indexOf(`|${name}|`) + name.length + 2);
    const unit = after.startsWith("%") ? "%" : /^ seconds?\b/.test(after) ? "s" : "";
    const values = stats[picked.get(name)!]!.values.map((v) => (unit && v.endsWith(unit) ? v.slice(0, -unit.length) : v));
    if (!values.every((v) => /^[\d.]+$/.test(v))) return null;
    out[name] = values;
  }
  return out;
}

const defKey = (t: string): string | null => {
  const tag = field(t, "LocalizeTag");
  return tag ? `${tag}|${field(t, "Icon") ?? ""}` : null;
};

function definitions(texts: string[]): Map<string, string> {
  const defs = new Map<string, string>();
  for (const t of texts) {
    if (field(t, "TypeName")) continue;
    const k = defKey(t);
    if (k && !defs.has(k)) defs.set(k, t);
  }
  return defs;
}

export function typeIcons(texts: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of texts) {
    const type = field(t, "TypeName");
    const icon = field(t, "Icon");
    if (type && icon && !out.has(type)) out.set(type, icon);
  }
  return out;
}

const ICON_CATEGORIES = ["MiscItems", "Consumables", "Melee", "LongGuns", "Pistols", "Suits", "Upgrades", "WeaponSkins"];

export function itemIconPaths(dict: Dict, texts: string[]): Map<string, string> {
  const ranked: [number, string, string][] = [];
  for (const t of texts) {
    const cat = field(t, "ProductCategory") ?? "";
    const rank = ICON_CATEGORIES.indexOf(cat);
    const type = field(t, "TypeName");
    const name = localized(dict, field(t, "LocalizeTag"));
    const icon = field(t, "Icon");
    if (cat === "WeaponSkins" && !/\/Skins\/(Helmets|Body|Legs|Totem)\//.test(type ?? "")) continue;
    if (rank >= 0 && name && icon && type) ranked.push([rank, name, icon]);
  }
  const out = new Map<string, string>();
  for (const [, name, icon] of ranked.sort((a, b) => a[0] - b[0])) if (!out.has(name)) out.set(name, icon);
  return out;
}

export async function buildUpgrades(
  dict: Dict,
  texts: string[],
  wikiRunes: Map<string, WikiRune> | null,
  previous: UpgradeData | null,
  icon: (path: string | null) => Promise<string | null>,
  gameValues: GameValues = async () => null,
): Promise<UpgradeData> {
  const loc = (tag: string | undefined) => localized(dict, tag);
  const searchTags = (t: string) =>
    (/^SearchTags=\{\n([\s\S]*?)\n\}/m.exec(t)?.[1] ?? "").split("\n").map((x) => loc(x.replace(/,$/, ""))).filter((x): x is string => !!x);
  const defs = definitions(texts);

  const items = new Map<string, { t: string; cat: string; name: string }>();
  for (const t of texts) {
    const type = field(t, "TypeName");
    const cat = field(t, "ProductCategory");
    const name = loc(field(t, "LocalizeTag"));
    if (!type || !cat || !name || items.has(type)) continue;
    items.set(type, { t, cat, name });
  }

  const runes: Record<string, RuneEntry> = {};
  for (const [type, { t, cat, name }] of items) {
    if (cat !== "Upgrades" || !type.startsWith("/SF/Upgrades/Runes/Weapon/")) continue;
    const w = wikiRunes?.get(type);
    const prev = wikiRunes ? undefined : previous?.runes[type];
    const key = defKey(t);
    const def = key ? defs.get(key) : undefined;
    const text = def ? loc(field(def, "EnhancementTag")) : null;
    const stats = w?.stats ?? prev?.stats ?? [];
    runes[type] = {
      name,
      desc: loc(field(t, "LocalizeDescTag")),
      text,
      vals: mergeRuneValues(text, def ? await gameValues(type, def) : null, runeValues(text, stats)),
      art: searchTags(t)[0] ?? w?.art ?? prev?.art ?? null,
      does: w?.does ?? prev?.does ?? null,
      slot: RUNE_SLOTS[/^BonusArtifactSlots=\{\n(\w+)/m.exec(def ?? "")?.[1] ?? ""] ?? w?.slot ?? prev?.slot ?? null,
      stats,
      icon: (await icon(field(t, "Icon") ?? null)) ?? prev?.icon ?? null,
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

  const gear: Record<string, GearEntry> = {};
  for (const [type, { t, cat, name }] of items) {
    if (cat !== "Consumables" || !type.startsWith("/SF/Types/Items/Consumables/") || !isGear(type)) continue;
    const desc = loc(field(t, "LocalizeDescTag"));
    if (!desc || field(t, "ShowInInventory") === "0") continue;
    const key = defKey(t);
    const def = key ? defs.get(key) : undefined;
    const virtue = /^_boostersRes=\/SF\/Types\/Game\/(Courage|Spirit|Grace)PotionBooster$/m.exec(def ?? "")?.[1];
    const habitat = listField(def, "TargetLocationTags").map((tag) => loc(`/SF/Language/Fish/FishBiome${tag}`)).filter((x): x is string => !!x);
    const natures = listField(def, "TargetFamilies")
      .map((f) => FISH_NATURES.indexOf(f))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)
      .map((i) => loc(`/SF/Language/Fish/FishingFamily${i + 1}`))
      .filter((x): x is string => !!x);
    gear[type] = {
      name,
      desc,
      kind: type.includes("/Tackle/") || type.includes("FishingSpool") ? "Fishing" : COMPANION_GEAR.test(type) ? "Companion" : "Supplies",
      icon: (await icon(field(t, "Icon") ?? null)) ?? previous?.gear[type]?.icon ?? null,
      ...(virtue ? { virtue } : {}),
      ...(habitat.length ? { habitat } : {}),
      ...(natures.length ? { natures } : {}),
    };
  }

  return { runes: sortedKeys(runes), joineries: sortedKeys(joineries), gear: sortedKeys(gear) };
}

export interface TalismanEntry {
  name: string;
  Courage: number;
  Spirit: number;
  Grace: number;
}

const VIRTUES: Record<string, "Courage" | "Spirit" | "Grace"> = { COURAGE: "Courage", SPIRIT: "Spirit", GRACE: "Grace" };

export function buildTalismans(dict: Dict, texts: string[]): Record<string, TalismanEntry> {
  const defs = definitions(texts);
  const out: Record<string, TalismanEntry> = {};
  for (const t of texts) {
    const type = field(t, "TypeName");
    const name = localized(dict, field(t, "LocalizeTag"));
    const key = defKey(t);
    if (!type?.startsWith("/SF/Upgrades/Skins/Totem/") || !name || !key || out[leafOf(type)]) continue;
    const def = defs.get(key) ?? "";
    const entry: TalismanEntry = { name, Courage: 0, Spirit: 0, Grace: 0 };
    let found = false;
    for (const m of def.matchAll(/^UpgradeType=AVATAR_ATTRIBUTE_PRIMARY_(\w+)\nOperationType=ADD_BASE\nValue=([\d.]+)$/gm)) {
      const virtue = VIRTUES[m[1]!];
      if (!virtue) continue;
      entry[virtue] += Number(m[2]);
      found = true;
    }
    if (found) out[leafOf(type)] = entry;
  }
  return sortedKeys(out);
}

export interface ArmourEntry {
  slot: "Helm" | "Cuirass" | "Leggings";
  set: string | null;
  rarity: string;
  physical: number;
  magick: number;
  stability: number;
  requires: { virtue: string; value: number } | null;
}

const ARMOUR_SLOTS: Record<string, ArmourEntry["slot"]> = { Helmets: "Helm", Body: "Cuirass", Legs: "Leggings" };
const AT_VIRTUES: Record<string, string> = { AT_COURAGE: "Courage", AT_SPIRIT: "Spirit", AT_GRACE: "Grace" };
const armourStem = (type: string): string => leafOf(type).replace(/(?:Closed|Open|Melee|Alt)*(?:Helmet|Helm|Body|Torso|Legs)$/, "");
const setWords = (name: string): string[] => name.replace(/'s\b/g, "").split(/\s+/).filter(Boolean);

export function buildArmour(dict: Dict, texts: string[], previous: Record<string, ArmourEntry> | null): Record<string, ArmourEntry> {
  const defs = definitions(texts);
  const pieces: { type: string; name: string; entry: ArmourEntry }[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    const type = field(t, "TypeName");
    const slot = ARMOUR_SLOTS[/^\/SF\/Upgrades\/Skins\/(\w+)\//.exec(type ?? "")?.[1] ?? ""];
    const name = localized(dict, field(t, "LocalizeTag"));
    const key = defKey(t);
    if (!type || !slot || !name || !key || seen.has(name)) continue;
    const def = defs.get(key) ?? "";
    const stats = /^Armour=\{\n([^}]*)\}/m.exec(def)?.[1];
    if (!stats) continue;
    seen.add(name);
    const stat = (k: string) => Number(new RegExp(`^${k}=([\\d.]+)$`, "m").exec(stats)?.[1] ?? 0);
    const req = /^Requirements=\{\n(AT_\w+)=(\d+)\n\}/m.exec(def);
    const rarity = (field(def, "Rarity") ?? "COMMON").toLowerCase();
    pieces.push({
      type,
      name,
      entry: {
        slot,
        set: null,
        rarity: rarity.charAt(0).toUpperCase() + rarity.slice(1),
        physical: stat("Physical"),
        magick: stat("Magick"),
        stability: stat("Stability"),
        requires: req && AT_VIRTUES[req[1]!] ? { virtue: AT_VIRTUES[req[1]!]!, value: Number(req[2]) } : null,
      },
    });
  }
  const byStem = new Map<string, string[]>();
  for (const p of pieces) byStem.set(armourStem(p.type), [...(byStem.get(armourStem(p.type)) ?? []), p.name]);
  const out: Record<string, ArmourEntry> = { ...(previous ?? {}) };
  for (const p of pieces) {
    const group = byStem.get(armourStem(p.type)) ?? [];
    const common = group.length > 1 ? setWords(group[0]!).filter((w) => !["of", "The", "Mask"].includes(w) && group.every((n) => setWords(n).includes(w))) : [];
    out[p.name] = { ...p.entry, set: previous?.[p.name]?.set ?? (common.length ? common.join(" ") : null) };
  }
  return sortedKeys(out);
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
  slot?: string;
  scaling?: string[];
  requires?: Record<string, number>;
}

const RECIPES = "/SF/Types/Recipes/";
const VIRTUE_NAMES: Record<string, string> = { AT_COURAGE: "Courage", AT_SPIRIT: "Spirit", AT_GRACE: "Grace" };

function blockLines(t: string, name: string): string[] {
  const lines = t.split("\n");
  const at = lines.indexOf(`${name}={`);
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1, depth = 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.endsWith("{")) depth++;
    else if (l === "}" || l === "},") depth--;
    if (depth === 0) break;
    out.push(l);
  }
  return out;
}

function virtueTotals(t: string, name: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of blockLines(t, name)) {
    const m = /^(AT_\w+)=(\d+(?:\.\d+)?)$/.exec(l);
    const v = m ? VIRTUE_NAMES[m[1]!] : undefined;
    if (v) out[v] = (out[v] ?? 0) + Number(m![2]);
  }
  return out;
}
const NOT_CRAFTS = /^(WeaponQuality|WeaponAspectManipulation|WeaponTitles)(\/|$)|ReforgeBlueprint$/;

export function recipeKind(type: string, name: string): [RecipeDef["station"], string] | null {
  const folder = type.slice(RECIPES.length, type.lastIndexOf("/"));
  if (NOT_CRAFTS.test(folder) || /ReforgeBlueprint$/.test(type)) return null;
  const top = folder.split("/")[0];
  if (top === "Elixers") return ["Brewing", "Elixirs"];
  if (top === "ColorPalettes") return ["Brewing", "Palettes"];
  if (top === "Consumeables") return ["Brewing", "Pup Treats"];
  if ((top === "Ingots" || top === "Quests") && /Chordstone/.test(name)) return ["Blacksmith", "Chordstones"];
  if (top === "Weapons") return ["Blacksmith", "Weapons"];
  if (top === "Armor") return ["Blacksmith", "Armour"];
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

  const typeText = new Map<string, string>();
  for (const t of texts) {
    const type = field(t, "TypeName");
    if (type && !typeText.has(type)) typeText.set(type, t);
  }
  const gear = (kind: string, made: string): Pick<RecipeDef, "slot" | "scaling" | "requires"> => {
    const own = typeText.get(made);
    if (!own || (kind !== "Weapons" && kind !== "Armour")) return {};
    const slot = kind === "Weapons" ? WEAPON_SLOTS[field(own, "ProductCategory") ?? ""] : ARMOUR_SLOTS[/\/Skins\/(Helmets|Body|Legs)\//.exec(made)?.[1] ?? ""];
    const attunes = virtueTotals(own, "Attunements");
    const scaling = Object.keys(attunes).sort((a, b) => attunes[b]! - attunes[a]!);
    const requires = virtueTotals(own, "Requirements");
    return { ...(slot ? { slot } : {}), ...(scaling.length ? { scaling } : {}), ...(Object.keys(requires).length ? { requires } : {}) };
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
      ...gear(kind[1], made),
    };
  }
  return sortedKeys(out);
}

export interface CraftDef {
  name: string;
  kind: string | null;
  result: string;
  seconds: number;
  icon: string | null;
  slot?: string;
}

const OTHER_CRAFT_KINDS: Record<string, string> = { Pacts: "Pacts", Totems: "Talismans" };

export function buildOtherCrafts(dict: Dict, texts: string[], names: Record<string, string>, recipes: Record<string, RecipeDef>): Record<string, CraftDef> {
  const tagOf = new Map<string, string>();
  for (const t of texts) {
    const type = /^TypeName=(\S+)$/m.exec(t)?.[1];
    const tag = /^LocalizeTag=(\S+)$/m.exec(t)?.[1];
    if (type && tag && !tagOf.has(type)) tagOf.set(type, tag);
  }
  const out: Record<string, CraftDef> = {};
  for (const t of texts) {
    const type = field(t, "TypeName");
    if (!type?.startsWith(RECIPES) || type in recipes || type in out) continue;
    const result = field(t, "ResultItem");
    const seconds = Number(field(t, "BuildTime") ?? 0);
    if (!result || !(seconds > 0)) continue;
    const made = result.replace("/SF/StoreItems/", "/SF/");
    const tag = field(t, "OverrideLocalizeTag") ?? field(t, "LocalizeTag") ?? tagOf.get(made);
    const leaf = leafOf(made);
    const name = (tag && usable(dict[tag]) ? dict[tag]!.trim() : null) ?? names[made] ?? names[leaf] ?? null;
    if (!name) continue;
    const top = type.slice(RECIPES.length).split("/")[0] ?? "";
    out[type] = { name, kind: OTHER_CRAFT_KINDS[top] ?? null, result: made, seconds, icon: null };
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

export interface TemperEntry {
  name: string;
  effect: string;
  icon?: string;
  weapons?: string[];
}

export interface ManifestEntry {
  tag: string;
  icon: string | null;
}

const MANIFESTS = "/SF/Types/Items/Aspects/";

export function aspectManifests(texts: string[], tree: TypeTree): Map<string, ManifestEntry[]> {
  const paths = [...tree.keys()].filter((p) => p.startsWith(MANIFESTS) && p.endsWith("AspectManifest") && !p.endsWith("/BaseAspectManifest"));
  const bodies = texts.filter((t) => /^UpgradeEntries=\{/m.test(t) && /^ItemCompatibility=/m.test(t) && /Origin\w+$|AspectManifest"?$/.test(field(t, "LocalizeTag") ?? ""));
  if (!paths.length || paths.length !== bodies.length) return new Map();
  const out = new Map<string, ManifestEntry[]>();
  for (const [i, body] of bodies.entries()) {
    const path = paths[i]!;
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    const tag = field(body, "LocalizeTag") ?? "";
    const named = /(\w+AspectManifest)"?$/.exec(tag)?.[1];
    const origin = /Origin(\w+)$/.exec(tag)?.[1];
    if (named ? named !== leaf : !origin || !leaf.startsWith(origin)) return new Map();
    out.set(path, [...body.matchAll(/^Tag=(\w+)\nIcon=(\S*)$/gm)].map((m) => ({ tag: m[1]!, icon: m[2]!.startsWith("/") ? m[2]! : null })));
  }
  return out;
}

export function buildTempers(dict: Dict, texts: string[], manifests: Map<string, ManifestEntry[]> = new Map(), weaponNames: Record<string, string> = {}): Record<string, TemperEntry> {
  const icons = new Map<string, string>();
  const weapons = new Map<string, Set<string>>();
  for (const entries of manifests.values()) for (const e of entries) if (e.icon && !icons.has(e.tag)) icons.set(e.tag, e.icon);
  for (const t of texts) {
    const type = field(t, "TypeName");
    const manifest = field(t, "AspectManifest");
    const name = type ? weaponNames[type] : undefined;
    if (!name || !manifest) continue;
    for (const e of manifests.get(manifest) ?? []) (weapons.get(e.tag) ?? weapons.set(e.tag, new Set()).get(e.tag)!).add(name);
  }
  const out: Record<string, TemperEntry> = {};
  for (const t of texts) {
    const type = field(t, "TypeName");
    if (!type?.startsWith("/SF/Types/Items/Aspects/Tempers/")) continue;
    const key = type.slice(type.lastIndexOf("/") + 1);
    const name = localized(dict, field(t, "LocalizeTag"));
    const effect = localized(dict, field(t, "LocalizeDescTag"));
    if (!name || !effect) continue;
    const on = [...(weapons.get(key) ?? [])].sort((a, b) => a.localeCompare(b));
    out[key] = { name, effect, ...(icons.has(key) ? { icon: icons.get(key)! } : {}), ...(on.length ? { weapons: on } : {}) };
  }
  return sortedKeys(out);
}

export interface TotemEntry {
  types: string[];
  animal: string;
  enhances: string;
  description: string;
  effect: string;
  base: string[][];
  grip: string[][];
}

export type GameValues = (type: string, def: string, variant?: number) => Promise<Record<string, string[]> | null>;

export async function buildTotemData(dict: Dict, texts: string[], previous: Record<string, TotemEntry> | null, values: GameValues): Promise<Record<string, TotemEntry>> {
  const defs = definitions(texts);
  const out: Record<string, TotemEntry> = {};
  for (const t of texts) {
    const type = field(t, "TypeName");
    if (!type?.startsWith("/SF/Upgrades/Totems/")) continue;
    const name = localized(dict, field(t, "LocalizeTag"));
    const key = defKey(t);
    const def = key ? defs.get(key) : undefined;
    const text = def ? localized(dict, field(def, "EnhancementTag")) : null;
    if (name && out[name] && !out[name]!.types.includes(type)) out[name]!.types.push(type);
    if (!name || !def || !text || out[name]) continue;
    const order = [...new Set([...text.matchAll(/\|(\w+)\|/g)].map((m) => m[1]!))];
    const base = order.length ? await values(type, def) : null;
    const grip = order.length ? await values(type, def, 1) : null;
    const prev = previous?.[name];
    out[name] = {
      types: [type],
      animal: prev?.animal ?? /\/Animals\/(\w+)\.png$/.exec(field(t, "Icon") ?? "")?.[1] ?? "",
      enhances: prev?.enhances ?? "",
      description: localized(dict, field(t, "LocalizeDescTag")) ?? "",
      effect: text.replace(/\|(\w+)\|/g, (_m, k: string) => `$${order.indexOf(k) + 1}`),
      base: order.map((k) => base?.[k] ?? []),
      grip: order.map((k) => grip?.[k] ?? base?.[k] ?? []),
    };
  }
  return sortedKeys(out);
}

export function buildPactArtTexts(dict: Dict, texts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of texts) {
    const tag = /^LocalizeTag=(\/SF\/Language\/Pacts\/\S+)$/m.exec(t)?.[1];
    if (!tag || !/^FusionLimit=/m.test(t)) continue;
    const name = localized(dict, tag);
    const desc = localized(dict, field(t, "LocalizeDescTag"));
    if (name && desc && !out[name]) out[name] = desc;
  }
  return sortedKeys(out);
}
