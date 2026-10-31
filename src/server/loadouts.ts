/** Parse loadout presets ("builds") from a raw inventory dump.
 *
 *  LoadOutPresets.NORMAL holds named presets; each references its gear by
 *  ItemId ($oid) in slots s (soul), l (primary/ranged), m (sidearm/melee),
 *  plus a `mod` index picking which of that gear's Configs is active.
 *
 *  Each gear item's Configs[mod].Upgrades is a list of upgrade ItemIds. Those
 *  resolve against the top-level Upgrades array, whose entries are the account's
 *  installed Runes (/SF/Upgrades/Runes/...) and Totems (/SF/Upgrades/Totems/...).
 *  So per slot we can report the weapon/soul ItemType and the Runes and Totems
 *  socketed into its active config. (Joineries - the connective links on the
 *  totem board - are not persisted in account data, so they cannot be read.)
 *
 *  The result is a portable build the app can display, export, and re-import.
 */

/** A Joinery (Kintsugi reforge) installed on a weapon. Only one at a time; the
 *  weapon stores it in its `UpgradeType`. The code's family names the Joinery
 *  product (which is tied to weapon type), and the SR<letter> suffix encodes the
 *  Virtue chosen at reforge time (C=Courage, S=Spirit, G=Grace) - the pips make
 *  the weapon scale harder with that Virtue. */
export interface Joinery {
  /** "Verite" | "Quicksilver" | "Feybalt" | "Gildaur", or null if unknown. */
  name: string | null;
  /** "Courage" | "Spirit" | "Grace", or null for obsolete reforges. */
  virtue: string | null;
  /** Cleaned upgrade code, e.g. "DefenseSRG" (kept for reference/export). */
  code: string;
  /** Blessing: "Blessed" | "Twice Blessed" | "Thrice Blessed", or null for
   *  obsolete (pre-Preludes 14) reforges. */
  tier?: JoineryTier | null;
  /** Attunement pips it adds (1-3), or null. */
  pips?: number | null;
}
export type JoineryTier = "Blessed" | "Twice Blessed" | "Thrice Blessed";

/** Points per Virtue in a loadout's allocation. */
export interface VirtuePoints {
  Courage: number;
  Spirit: number;
  Grace: number;
}

export interface TotemRef {
  type: string;
  /** In-game rank (fingerprint lvl + 1), or null if unranked. */
  rank: number | null;
  /** Totem slot on the weapon, 1-4. A config's Upgrades list is positional:
   *  index 0 holds the Rune, 1-4 the totem slots (4 is the one the Rune unlocks). */
  slot: number | null;
  /** The totem's own attuned Virtue (fingerprint "pol"). */
  virtue: "Courage" | "Spirit" | "Grace" | null;
}

export interface SlotGear {
  /** Weapon/soul ItemType, or null when the slot is empty. */
  type: string | null;
  /** Rune ItemTypes installed in this slot's active config. */
  runes: string[];
  /** Totems installed in this slot's active config, with their rank (lvl+1). */
  totems: TotemRef[];
  /** Installed Joinery (weapons only), or null. */
  joinery: Joinery | null;
  /** Craftwork quality (raw IQ_* value; weapons only), or null. */
  craftwork: string | null;
  /** Temper mod tags on this weapon (AspectFingerprint.buffs). */
  tempers: string[];
  /** Pact Arts allocation (Pact slot only): skill key ("Folder/Skill", the
   *  ItemType after "/Pacts/") -> ranks allocated (0 = locked). */
  arts?: Record<string, number> | null;
}

/** The armour worn with a loadout (ItemTypes; null for an empty slot). */
export interface ArmourSet {
  helm: string | null;
  cuirass: string | null;
  leggings: string | null;
}

export interface Build {
  name: string;
  favorite: boolean;
  /** The loadout's allocation of the Envoy's intrinsic Virtue points. */
  virtues?: VirtuePoints | null;
  /** The Talisman worn with this loadout (its ItemType), which may add Virtues. */
  talisman?: string | null;
  /** The Helm, Cuirass and Leggings worn with this loadout. */
  armour?: ArmourSet | null;
  /** Account-wide Virtue points from Fable choices (+1 each). */
  fables?: VirtuePoints | null;
  soul: SlotGear;
  ranged: SlotGear;
  melee: SlotGear;
}

interface Slot {
  ItemId?: { $oid?: string };
  mod?: number;
  /** Which config holds the appearance (armour, Talisman). */
  cus?: number;
}

export interface GearInfo {
  type: string;
  /** Per-config lists of upgrade ItemIds (Configs[i].Upgrades). */
  configs: string[][];
  /** Per-config appearance: armour/Talisman ItemIds or paths (Configs[i].Skins). */
  skins: string[][];
  /** The weapon's installed Joinery id (UpgradeType), if any. */
  upgradeType: string | undefined;
  /** Craftwork quality (raw IQ_* value), if any. */
  craftwork: string | null;
  /** Temper mod tags (AspectFingerprint.buffs). */
  tempers: string[];
}

const EMPTY_SLOT: SlotGear = { type: null, runes: [], totems: [], joinery: null, craftwork: null, tempers: [] };

/** Parse a totem/rune UpgradeFingerprint string for its level (0-based) and,
 *  for totems, attuned Virtue. */
const POL_VIRTUE: Record<string, TotemRef["virtue"]> = { AP_COURAGE: "Courage", AP_SPIRIT: "Spirit", AP_GRACE: "Grace" };
function parseFingerprint(fp: unknown): { lvl: number | null; virtue: TotemRef["virtue"] } {
  if (typeof fp !== "string") return { lvl: null, virtue: null };
  try {
    const f = JSON.parse(fp) as { lvl?: unknown; pol?: unknown };
    return {
      lvl: typeof f.lvl === "number" ? f.lvl : null,
      virtue: (typeof f.pol === "string" && POL_VIRTUE[f.pol]) || null,
    };
  } catch {
    return { lvl: null, virtue: null };
  }
}

/** Pact ItemType leaf -> its SkillTrees leaf. Wyld variants share their base
 *  Pact's tree. Anything unlisted falls back to "<Name>Soul" -> "<Name>PactSkillTree". */
const SOUL_TREE: Record<string, string> = {
  OdeSoul: "OdePactSkillTree",
  StagSoul: "GarrenPactSkillTree",
  WolfSoul: "WolfPactSkillTree",
  BromiusSoul: "BromiusPactSkillTree",
  FennSoul: "FennPactSkillTree",
  FencerSoul: "FencerPactSkillTree",
  ChampionSoul: "FeyChampionPactSkillTree",
  PothiaSoul: "FeyChampionPactSkillTree",
  WardSoul: "FeyWardPactSkillTree",
  GaleneSoul: "FeyWardPactSkillTree",
  SaboteurSoul: "FeySaboteurPactSkillTree",
  JolsafarSoul: "FeySaboteurPactSkillTree",
};

/** SkillTrees -> { treeLeaf: { "Folder/Skill": level } } for the Pact trees. */
export function parsePactArts(raw: unknown): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  const trees = (raw as Record<string, unknown> | null)?.SkillTrees;
  if (!Array.isArray(trees)) return out;
  for (const t of trees) {
    const tree = t as { ItemType?: unknown; Skills?: unknown };
    if (typeof tree.ItemType !== "string" || !tree.ItemType.endsWith("PactSkillTree")) continue;
    const skills: Record<string, number> = {};
    for (const sk of Array.isArray(tree.Skills) ? tree.Skills : []) {
      const e = sk as { ItemType?: unknown; Level?: unknown };
      if (typeof e.ItemType !== "string") continue;
      const key = e.ItemType.split("/Pacts/")[1];
      if (key) skills[key] = typeof e.Level === "number" && Number.isFinite(e.Level) ? e.Level : 0;
    }
    out.set(tree.ItemType.split("/").pop()!, skills);
  }
  return out;
}

/** The Pact Arts allocation for a Pact ItemType, or null if it has no tree. */
function artsFor(soulType: string, trees: Map<string, Record<string, number>>): Record<string, number> | null {
  const leaf = soulType.split("/").pop() ?? "";
  const treeLeaf = SOUL_TREE[leaf] ?? leaf.replace(/Soul$/, "PactSkillTree");
  return trees.get(treeLeaf) ?? null;
}

const VIRTUE: Record<string, string> = { C: "Courage", S: "Spirit", G: "Grace" };
// Code family -> Joinery product. Verite/Quicksilver/Feybalt are weapon-type
// specific (Melee/Ranged/Magick); Gildaur is universal (the "Defense" family,
// which shows up across every weapon type in practice).
const JOINERY_BY_FAMILY: Record<string, string> = {
  Melee: "Verite",
  Ranged: "Quicksilver",
  Caster: "Feybalt",
  Defense: "Gildaur",
};

// Blessing tier from the code after its family (the game's type tree lists
// every code; its Joinery item names line up the same way):
//   C / UC / R  Blessed by Mora / Iridis / Saphene: +1 Courage / Spirit / Grace
//   SR<V>Two    Twice Blessed, +2 (Quicksilver and Feybalt)
//   SR<V>       the family's top tier: Twice Blessed for Verite, which has no
//               Thrice; Thrice Blessed (+3) for Gildaur, Quicksilver and Feybalt
// Codes outside these families (e.g. "KintsugiUpgradeD") are pre-Preludes 14.
const BLESSED_BY: Record<string, string> = { C: "Courage", UC: "Spirit", R: "Grace" };

/** Decode a weapon's UpgradeType (Kintsugi reforge) into a Joinery. */
export function decodeJoinery(upgradeType: string | undefined): Joinery | null {
  if (!upgradeType) return null;
  const leaf = upgradeType.split("/").pop() || upgradeType;
  const code = leaf.replace(/^Kintsugi(?:Weapon)?Upgrade/, "");
  const family = code.match(/^(Melee|Ranged|Caster|Defense)/)?.[1];
  let virtue: string | null = null;
  let tier: JoineryTier | null = null;
  let pips: number | null = null;
  if (family) {
    const rest = code.slice(family.length);
    const top = rest.match(/^(?:Fey)?SR([CSG])(Two)?$/);
    if (top) {
      const twice = top[2] !== undefined || family === "Melee";
      virtue = VIRTUE[top[1]!] ?? null;
      tier = twice ? "Twice Blessed" : "Thrice Blessed";
      pips = twice ? 2 : 3;
    } else if (BLESSED_BY[rest]) {
      virtue = BLESSED_BY[rest]!;
      tier = "Blessed";
      pips = 1;
    }
  }
  return { name: family ? (JOINERY_BY_FAMILY[family] ?? null) : null, virtue, code, tier, pips };
}

/** Starting Virtue points; each Envoy Rank adds one. */
const BASE_VIRTUE_POINTS = 16;

/** A loadout's Virtue allocation. The preset stores each Virtue's share of the
 *  Envoy's intrinsic points (16 + Envoy Rank) as a spot in the Arsenal's
 *  triangle: vu = Spirit, vv = Grace, Courage the rest, in 1/255 steps.
 *  Whole points, as the Arsenal shows them: every Virtue starts with 1 (the
 *  DynamicVirtues item's base Distribution), the other points are split by the
 *  shares and rounded down, and the Virtue with the largest share takes what's
 *  left (on a tie, the first in stored order: Spirit, Grace, Courage). Checked
 *  against eight loadouts in game, e.g. shares of 66 / 56 / 133 (Spirit / Grace
 *  / Courage) at 33 points: 1 + 7.76, 1 + 6.59 and 1 + 15.65 round down to
 *  8 / 7 / 16, and Courage takes the 2 left over: 8 / 7 / 18. A Virtue with no
 *  share still gets its 1. The math runs on whole 1/255 units, so exact cases
 *  stay exact. Points from talismans, Pact Art passives and Fables come on top. */
export function virtuePoints(vu: unknown, vv: unknown, envoyRank: unknown): VirtuePoints | null {
  if (typeof vu !== "number" || typeof vv !== "number" || typeof envoyRank !== "number") return null;
  const total = BASE_VIRTUE_POINTS + envoyRank;
  const split = total - 3;
  const u = Math.min(255, Math.max(0, Math.round(vu * 255)));
  const v = Math.min(255 - u, Math.max(0, Math.round(vv * 255)));
  const order: [keyof VirtuePoints, number][] = [
    ["Spirit", u],
    ["Grace", v],
    ["Courage", 255 - u - v],
  ];
  const out: VirtuePoints = { Courage: 0, Spirit: 0, Grace: 0 };
  let top = order[0]!;
  for (const entry of order) {
    out[entry[0]] = 1 + Math.floor((entry[1] * split) / 255);
    if (entry[1] > top[1]) top = entry;
  }
  out[top[0]] += total - (out.Courage + out.Spirit + out.Grace);
  return out;
}

/** Virtue points from Fable choices (BonusAttributes: AT_COURAGE etc., +1 each). */
export function fableVirtues(raw: Record<string, unknown>): VirtuePoints {
  const out: VirtuePoints = { Courage: 0, Spirit: 0, Grace: 0 };
  const AT: Record<string, keyof VirtuePoints> = { AT_COURAGE: "Courage", AT_SPIRIT: "Spirit", AT_GRACE: "Grace" };
  for (const b of Array.isArray(raw.BonusAttributes) ? raw.BonusAttributes : []) {
    const k = AT[(b as { value?: string })?.value ?? ""];
    if (k) out[k] += 1;
  }
  return out;
}

/** ItemId -> { ItemType, per-config upgrade id lists } for every gear item. */
export function gearIndex(raw: Record<string, unknown>): Map<string, GearInfo> {
  const idx = new Map<string, GearInfo>();
  for (const cat of ["Suits", "Melee", "LongGuns", "Pistols", "OperatorAmps"]) {
    const list = raw[cat];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = entry as { ItemId?: { $oid?: string }; ItemType?: string; Configs?: unknown; UpgradeType?: unknown; Quality?: unknown; AspectFingerprint?: unknown };
      const oid = e?.ItemId?.$oid;
      if (!oid || typeof e.ItemType !== "string") continue;
      const strings = (key: "Upgrades" | "Skins") =>
        (Array.isArray(e.Configs) ? e.Configs : []).map((c) => {
          const list = (c as Record<string, unknown>)?.[key];
          return Array.isArray(list) ? list.filter((u): u is string => typeof u === "string") : [];
        });
      const configs = strings("Upgrades");
      const fp = e.AspectFingerprint as { buffs?: unknown } | undefined;
      const tempers = Array.isArray(fp?.buffs)
        ? fp!.buffs.map((b) => (b as { Tag?: unknown }).Tag).filter((t): t is string => typeof t === "string")
        : [];
      idx.set(oid, {
        type: e.ItemType,
        configs,
        skins: strings("Skins"),
        upgradeType: typeof e.UpgradeType === "string" ? e.UpgradeType : undefined,
        craftwork: typeof e.Quality === "string" ? e.Quality : null,
        tempers,
      });
    }
  }
  return idx;
}

/** Installed-upgrade ItemId -> { ItemType, lvl, virtue } (Runes and Totems live here). */
function upgradeIndex(raw: Record<string, unknown>): Map<string, { type: string; lvl: number | null; virtue: TotemRef["virtue"] }> {
  const idx = new Map<string, { type: string; lvl: number | null; virtue: TotemRef["virtue"] }>();
  const list = raw.Upgrades;
  if (!Array.isArray(list)) return idx;
  for (const entry of list) {
    const u = entry as { ItemId?: { $oid?: string }; ItemType?: string; UpgradeFingerprint?: unknown };
    const oid = u?.ItemId?.$oid;
    if (oid && typeof u.ItemType === "string") idx.set(oid, { type: u.ItemType, ...parseFingerprint(u.UpgradeFingerprint) });
  }
  return idx;
}

export function parseBuilds(raw: unknown): Build[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const presets = (record.LoadOutPresets as { NORMAL?: unknown })?.NORMAL;
  if (!Array.isArray(presets)) return [];

  const gear = gearIndex(record);
  const upgrades = upgradeIndex(record);
  const trees = parsePactArts(record);
  const fables = fableVirtues(record);
  // Appearance items (armour, Talismans) by ItemId.
  const skinTypes = new Map<string, string>();
  for (const e of Array.isArray(record.WeaponSkins) ? record.WeaponSkins : []) {
    const w = e as { ItemId?: { $oid?: string }; ItemType?: unknown };
    if (w?.ItemId?.$oid && typeof w.ItemType === "string") skinTypes.set(w.ItemId.$oid, w.ItemType);
  }
  // The armour and Talisman worn with a loadout sit in its Pact's appearance
  // config: owned pieces by ItemId, default ones by ItemType path.
  const appearanceOf = (slot: unknown): string[] => {
    const s = slot as Slot;
    const info = s?.ItemId?.$oid ? gear.get(s.ItemId.$oid) : undefined;
    if (!info) return [];
    const pick = [s.cus, s.mod, 0].find((i): i is number => typeof i === "number" && i >= 0 && i < info.skins.length);
    const skins = pick !== undefined ? info.skins[pick]! : [];
    return skins.map((id) => skinTypes.get(id) ?? (id.startsWith("/") ? id : "")).filter(Boolean);
  };
  const inFolder = (types: string[], folder: string) => types.find((t) => t.includes(`/Skins/${folder}/`)) ?? null;

  const resolve = (slot: unknown): SlotGear => {
    const s = slot as Slot;
    const oid = s?.ItemId?.$oid;
    if (!oid) return { ...EMPTY_SLOT };
    const info = gear.get(oid);
    if (!info) return { ...EMPTY_SLOT };
    const cfg = info.configs[typeof s.mod === "number" ? s.mod : 0] ?? info.configs[0] ?? [];
    const runes: string[] = [];
    const totems: TotemRef[] = [];
    cfg.forEach((upId, i) => {
      const info = upgrades.get(upId);
      if (!info) return;
      if (info.type.includes("/Upgrades/Runes/")) runes.push(info.type);
      else if (info.type.includes("/Upgrades/Totems/")) {
        totems.push({
          type: info.type,
          rank: info.lvl != null ? info.lvl + 1 : null,
          slot: i >= 1 && i <= 4 ? i : null,
          virtue: info.virtue,
        });
      }
    });
    return { type: info.type, runes, totems, joinery: decodeJoinery(info.upgradeType), craftwork: info.craftwork, tempers: info.tempers };
  };

  const withArts = (slot: SlotGear): SlotGear => (slot.type ? { ...slot, arts: artsFor(slot.type, trees) } : slot);

  return presets.map((p) => {
    const preset = p as Record<string, unknown>;
    const worn = appearanceOf(preset.s);
    return {
      name: typeof preset.n === "string" && preset.n ? preset.n : "Unnamed",
      favorite: preset.Favorite === true,
      virtues: virtuePoints(preset.vu, preset.vv, record.PlayerLevel),
      talisman: inFolder(worn, "Totem"),
      armour: worn.length
        ? { helm: inFolder(worn, "Helmets"), cuirass: inFolder(worn, "Body"), leggings: inFolder(worn, "Legs") }
        : null,
      fables,
      soul: withArts(resolve(preset.s)),
      ranged: resolve(preset.l),
      melee: resolve(preset.m),
    };
  });
}
