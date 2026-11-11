import { gearIndex } from "./loadouts";

export interface OwnedTotem {
  id: string;
  type: string;
  rank: number;
  virtue: "Courage" | "Spirit" | "Grace" | null;
  grip: string;
  equippedOn: string[];
}

const VIRTUE: Record<string, OwnedTotem["virtue"]> = {
  AP_COURAGE: "Courage",
  AP_SPIRIT: "Spirit",
  AP_GRACE: "Grace",
};

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
  return GRIP[leaf] ?? leaf.replace(/SkillTree$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function parseTotems(raw: unknown): OwnedTotem[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const list = record.Upgrades;
  if (!Array.isArray(list)) return [];

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

export function totemNamer(data: Record<string, { types?: string[] }> | null, items: Record<string, string> = {}): (type: string) => string {
  const byType = new Map<string, string>();
  for (const [name, d] of Object.entries(data ?? {})) for (const t of d.types ?? []) byType.set(t, name);
  return (type) => {
    const leaf = type.split("/").pop() ?? type;
    return byType.get(type) ?? items[type] ?? items[leaf] ?? leaf.replace(/([a-z])([A-Z])/g, "$1 $2");
  };
}

export function newStarredTotems(before: OwnedTotem[] | null, after: OwnedTotem[], watch: readonly string[], nameOf: (type: string) => string): OwnedTotem[] {
  if (!before || !watch.length) return [];
  const starred = new Set(watch);
  const counts = (list: OwnedTotem[]) => {
    const m = new Map<string, number>();
    for (const t of list) m.set(nameOf(t.type), (m.get(nameOf(t.type)) ?? 0) + 1);
    return m;
  };
  const had = counts(before);
  const room = new Map([...counts(after)].map(([n, c]) => [n, c - (had.get(n) ?? 0)]));
  const known = new Set(before.map((t) => t.id));
  const out: OwnedTotem[] = [];
  for (const t of after) {
    const name = nameOf(t.type);
    if (!starred.has(name) || known.has(t.id) || (room.get(name) ?? 0) <= 0) continue;
    room.set(name, room.get(name)! - 1);
    out.push(t);
  }
  return out;
}
