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
  /** "Courage" | "Spirit" | "Grace", or null for plain/obsolete reforges. */
  virtue: string | null;
  /** Cleaned upgrade code, e.g. "DefenseSRG" (kept for reference/export). */
  code: string;
}

export interface TotemRef {
  type: string;
  /** In-game rank (fingerprint lvl + 1), or null if unranked. */
  rank: number | null;
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

export interface Build {
  name: string;
  favorite: boolean;
  soul: SlotGear;
  ranged: SlotGear;
  melee: SlotGear;
}

interface Slot {
  ItemId?: { $oid?: string };
  mod?: number;
}

interface GearInfo {
  type: string;
  /** Per-config lists of upgrade ItemIds (Configs[i].Upgrades). */
  configs: string[][];
  /** The weapon's installed Joinery id (UpgradeType), if any. */
  upgradeType: string | undefined;
  /** Craftwork quality (raw IQ_* value), if any. */
  craftwork: string | null;
  /** Temper mod tags (AspectFingerprint.buffs). */
  tempers: string[];
}

const EMPTY_SLOT: SlotGear = { type: null, runes: [], totems: [], joinery: null, craftwork: null, tempers: [] };

/** Parse a totem/rune UpgradeFingerprint string for its level (0-based). */
function fingerprintLvl(fp: unknown): number | null {
  if (typeof fp !== "string") return null;
  try {
    const lvl = (JSON.parse(fp) as { lvl?: unknown }).lvl;
    return typeof lvl === "number" ? lvl : null;
  } catch {
    return null;
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

/** Decode a weapon's UpgradeType (Kintsugi reforge) into a Joinery. */
function decodeJoinery(upgradeType: string | undefined): Joinery | null {
  if (!upgradeType) return null;
  const leaf = upgradeType.split("/").pop() || upgradeType;
  const code = leaf.replace(/^Kintsugi(?:Weapon)?Upgrade/, "");
  const family = code.match(/^(Melee|Ranged|Caster|Defense)/)?.[1];
  // Attuned reforges end in SR<Virtue> (optionally a higher "Two" tier).
  const letter = leaf.match(/SR([CSG])(?:Two)?$/)?.[1];
  return {
    name: family ? (JOINERY_BY_FAMILY[family] ?? null) : null,
    virtue: letter ? (VIRTUE[letter] ?? null) : null,
    code,
  };
}

/** ItemId -> { ItemType, per-config upgrade id lists } for every gear item. */
function gearIndex(raw: Record<string, unknown>): Map<string, GearInfo> {
  const idx = new Map<string, GearInfo>();
  for (const cat of ["Suits", "Melee", "LongGuns", "Pistols", "OperatorAmps"]) {
    const list = raw[cat];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = entry as { ItemId?: { $oid?: string }; ItemType?: string; Configs?: unknown; UpgradeType?: unknown; Quality?: unknown; AspectFingerprint?: unknown };
      const oid = e?.ItemId?.$oid;
      if (!oid || typeof e.ItemType !== "string") continue;
      const configs = (Array.isArray(e.Configs) ? e.Configs : []).map((c) => {
        const ups = (c as { Upgrades?: unknown })?.Upgrades;
        return Array.isArray(ups) ? ups.filter((u): u is string => typeof u === "string") : [];
      });
      const fp = e.AspectFingerprint as { buffs?: unknown } | undefined;
      const tempers = Array.isArray(fp?.buffs)
        ? fp!.buffs.map((b) => (b as { Tag?: unknown }).Tag).filter((t): t is string => typeof t === "string")
        : [];
      idx.set(oid, {
        type: e.ItemType,
        configs,
        upgradeType: typeof e.UpgradeType === "string" ? e.UpgradeType : undefined,
        craftwork: typeof e.Quality === "string" ? e.Quality : null,
        tempers,
      });
    }
  }
  return idx;
}

/** Installed-upgrade ItemId -> { ItemType, lvl } (Runes and Totems live here). */
function upgradeIndex(raw: Record<string, unknown>): Map<string, { type: string; lvl: number | null }> {
  const idx = new Map<string, { type: string; lvl: number | null }>();
  const list = raw.Upgrades;
  if (!Array.isArray(list)) return idx;
  for (const entry of list) {
    const u = entry as { ItemId?: { $oid?: string }; ItemType?: string; UpgradeFingerprint?: unknown };
    const oid = u?.ItemId?.$oid;
    if (oid && typeof u.ItemType === "string") idx.set(oid, { type: u.ItemType, lvl: fingerprintLvl(u.UpgradeFingerprint) });
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

  const resolve = (slot: unknown): SlotGear => {
    const s = slot as Slot;
    const oid = s?.ItemId?.$oid;
    if (!oid) return { ...EMPTY_SLOT };
    const info = gear.get(oid);
    if (!info) return { ...EMPTY_SLOT };
    const cfg = info.configs[typeof s.mod === "number" ? s.mod : 0] ?? info.configs[0] ?? [];
    const runes: string[] = [];
    const totems: TotemRef[] = [];
    for (const upId of cfg) {
      const info = upgrades.get(upId);
      if (!info) continue;
      if (info.type.includes("/Upgrades/Runes/")) runes.push(info.type);
      else if (info.type.includes("/Upgrades/Totems/")) totems.push({ type: info.type, rank: info.lvl != null ? info.lvl + 1 : null });
    }
    return { type: info.type, runes, totems, joinery: decodeJoinery(info.upgradeType), craftwork: info.craftwork, tempers: info.tempers };
  };

  const withArts = (slot: SlotGear): SlotGear => (slot.type ? { ...slot, arts: artsFor(slot.type, trees) } : slot);

  return presets.map((p) => {
    const preset = p as Record<string, unknown>;
    return {
      name: typeof preset.n === "string" && preset.n ? preset.n : "Unnamed",
      favorite: preset.Favorite === true,
      soul: withArts(resolve(preset.s)),
      ranged: resolve(preset.l),
      melee: resolve(preset.m),
    };
  });
}
