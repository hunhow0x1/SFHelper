/** Owned Totems, from the inventory's Upgrades list.
 *
 *  Each totem is an upgrade instance whose UpgradeFingerprint carries:
 *    pol    - its attuned Virtue (AP_COURAGE / AP_SPIRIT / AP_GRACE);
 *    compat - its grip: "/SF/Types/Game/SFSkillTree" is Universal, otherwise
 *             the weapon technique tree of the Combat Art it is aligned to;
 *    lvl    - rank, 0-based (absent = rank 1).
 *  Effects, animal and trigger come from the wiki (totemdata.json) client-side.
 */

import { gearIndex } from "./loadouts";

export interface OwnedTotem {
  id: string;
  /** ItemType, e.g. /SF/Upgrades/Totems/RuneDamageBuff */
  type: string;
  /** 1-4. */
  rank: number;
  virtue: "Courage" | "Spirit" | "Grace" | null;
  /** Combat Art the totem is aligned to, or "Universal". */
  grip: string;
  /** ItemTypes of the weapons this totem is slotted into (any config). */
  equippedOn: string[];
}

const VIRTUE: Record<string, OwnedTotem["virtue"]> = {
  AP_COURAGE: "Courage",
  AP_SPIRIT: "Spirit",
  AP_GRACE: "Grace",
};

/** Weapon technique tree -> the Combat Art name the game shows on the card. */
const GRIP: Record<string, string> = {
  SFSkillTree: "Universal",
  ArcherySkillTree: "Bow",
  SecondaryThrowingKnivesSkillTree: "Flyblade",
  GreatswordSkillTree: "Heavy",
  SwordSkillTree: "Long Blade",
  CastingSkillTree: "Magick",
  PolearmSkillTree: "Polearm",
  ShieldSkillTree: "Shield",
  DaggerSkillTree: "Short Blade",
};

function gripOf(compat: unknown): string {
  if (typeof compat !== "string" || !compat) return "Universal";
  const leaf = compat.split("/").pop()!;
  // Unknown trees (new Combat Arts): "FooBarSkillTree" -> "Foo Bar".
  return GRIP[leaf] ?? leaf.replace(/SkillTree$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function parseTotems(raw: unknown): OwnedTotem[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const list = record.Upgrades;
  if (!Array.isArray(list)) return [];

  // Totem ItemId -> weapons it's slotted into.
  const slotted = new Map<string, Set<string>>();
  for (const info of gearIndex(record).values()) {
    if (info.type.includes("/Souls/")) continue;
    for (const cfg of info.configs) {
      for (const up of cfg) {
        if (!slotted.has(up)) slotted.set(up, new Set());
        slotted.get(up)!.add(info.type);
      }
    }
  }

  const out: OwnedTotem[] = [];
  for (const entry of list) {
    const u = entry as { ItemId?: { $oid?: string }; ItemType?: unknown; UpgradeFingerprint?: unknown };
    const id = u?.ItemId?.$oid;
    if (!id || typeof u.ItemType !== "string" || !u.ItemType.includes("/Upgrades/Totems/")) continue;
    let fp: { pol?: unknown; compat?: unknown; lvl?: unknown } = {};
    try {
      if (typeof u.UpgradeFingerprint === "string") fp = JSON.parse(u.UpgradeFingerprint) as typeof fp;
    } catch {
      // Unreadable fingerprint: keep the totem with defaults.
    }
    out.push({
      id,
      type: u.ItemType,
      rank: typeof fp.lvl === "number" ? fp.lvl + 1 : 1,
      virtue: (typeof fp.pol === "string" && VIRTUE[fp.pol]) || null,
      grip: gripOf(fp.compat),
      equippedOn: [...(slotted.get(id) ?? [])],
    });
  }
  return out;
}
