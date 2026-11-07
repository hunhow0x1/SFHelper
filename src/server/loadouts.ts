export interface Joinery {
  name: string | null;
  virtue: string | null;
  code: string;
  tier?: JoineryTier | null;
  pips?: number | null;
}
export type JoineryTier = "Blessed" | "Twice Blessed" | "Thrice Blessed";

export interface VirtuePoints {
  Courage: number;
  Spirit: number;
  Grace: number;
}

export interface TotemRef {
  type: string;
  rank: number | null;
  slot: number | null;
  virtue: "Courage" | "Spirit" | "Grace" | null;
}

export interface SlotGear {
  type: string | null;
  runes: string[];
  runeLevels: (number | null)[];
  totems: TotemRef[];
  joinery: Joinery | null;
  craftwork: string | null;
  tempers: string[];
  arts?: Record<string, number> | null;
}

export interface ArmourSet {
  helm: string | null;
  cuirass: string | null;
  leggings: string | null;
}

export interface Build {
  name: string;
  favorite: boolean;
  virtues?: VirtuePoints | null;
  virtueShares?: { vu: number; vv: number } | null;
  talisman?: string | null;
  armour?: ArmourSet | null;
  fables?: VirtuePoints | null;
  soul: SlotGear;
  ranged: SlotGear;
  melee: SlotGear;
}

interface Slot {
  ItemId?: { $oid?: string };
  mod?: number;
  cus?: number;
}

export interface GearInfo {
  type: string;
  configs: string[][];
  skins: string[][];
  upgradeType: string | undefined;
  craftwork: string | null;
  tempers: string[];
}

const EMPTY_SLOT: SlotGear = { type: null, runes: [], runeLevels: [], totems: [], joinery: null, craftwork: null, tempers: [] };

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

function artsFor(soulType: string, trees: Map<string, Record<string, number>>): Record<string, number> | null {
  const leaf = soulType.split("/").pop() ?? "";
  const treeLeaf = SOUL_TREE[leaf] ?? leaf.replace(/Soul$/, "PactSkillTree");
  return trees.get(treeLeaf) ?? null;
}

const VIRTUE: Record<string, string> = { C: "Courage", S: "Spirit", G: "Grace" };
const JOINERY_BY_FAMILY: Record<string, string> = {
  Melee: "Verite",
  Ranged: "Quicksilver",
  Caster: "Feybalt",
  Defense: "Gildaur",
};

const BLESSED_BY: Record<string, string> = { C: "Courage", UC: "Spirit", R: "Grace" };

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

const BASE_VIRTUE_POINTS = 16;

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

export function fableVirtues(raw: Record<string, unknown>): VirtuePoints {
  const out: VirtuePoints = { Courage: 0, Spirit: 0, Grace: 0 };
  const AT: Record<string, keyof VirtuePoints> = { AT_COURAGE: "Courage", AT_SPIRIT: "Spirit", AT_GRACE: "Grace" };
  for (const b of Array.isArray(raw.BonusAttributes) ? raw.BonusAttributes : []) {
    const k = AT[(b as { value?: string })?.value ?? ""];
    if (k) out[k] += 1;
  }
  return out;
}

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
  const skinTypes = new Map<string, string>();
  for (const e of Array.isArray(record.WeaponSkins) ? record.WeaponSkins : []) {
    const w = e as { ItemId?: { $oid?: string }; ItemType?: unknown };
    if (w?.ItemId?.$oid && typeof w.ItemType === "string") skinTypes.set(w.ItemId.$oid, w.ItemType);
  }
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
    const runeLevels: (number | null)[] = [];
    const totems: TotemRef[] = [];
    cfg.forEach((upId, i) => {
      const info = upgrades.get(upId);
      if (!info) return;
      if (info.type.includes("/Upgrades/Runes/")) {
        runes.push(info.type);
        runeLevels.push(info.lvl ?? null);
      } else if (info.type.includes("/Upgrades/Totems/")) {
        totems.push({
          type: info.type,
          rank: info.lvl != null ? info.lvl + 1 : null,
          slot: i >= 1 && i <= 4 ? i : null,
          virtue: info.virtue,
        });
      }
    });
    return { type: info.type, runes, runeLevels, totems, joinery: decodeJoinery(info.upgradeType), craftwork: info.craftwork, tempers: info.tempers };
  };

  const withArts = (slot: SlotGear): SlotGear => (slot.type ? { ...slot, arts: artsFor(slot.type, trees) } : slot);

  return presets.map((p) => {
    const preset = p as Record<string, unknown>;
    const worn = appearanceOf(preset.s);
    return {
      name: typeof preset.n === "string" && preset.n ? preset.n : "Unnamed",
      favorite: preset.Favorite === true,
      virtues: virtuePoints(preset.vu, preset.vv, record.PlayerLevel),
      virtueShares: typeof preset.vu === "number" && typeof preset.vv === "number" ? { vu: preset.vu, vv: preset.vv } : null,
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
