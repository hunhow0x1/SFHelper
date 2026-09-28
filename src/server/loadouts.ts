/** Parse loadout presets ("builds") from a raw inventory dump.
 *
 *  LoadOutPresets.NORMAL holds named presets; each references its gear by
 *  ItemId ($oid) in slots s (soul), l (ranged), m (melee). We resolve those
 *  ids against the gear arrays to get ItemTypes, which the dashboard turns into
 *  in-game names. The result is a portable build the app can display, export,
 *  and re-import.
 */

export interface Build {
  name: string;
  favorite: boolean;
  soul: string | null;
  ranged: string | null;
  melee: string | null;
}

interface Slot {
  ItemId?: { $oid?: string };
}

function idIndex(raw: Record<string, unknown>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const cat of ["Suits", "Melee", "LongGuns", "Pistols", "OperatorAmps"]) {
    const list = raw[cat];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const oid = (entry as { ItemId?: { $oid?: string } })?.ItemId?.$oid;
      const type = (entry as { ItemType?: string })?.ItemType;
      if (oid && typeof type === "string") idx.set(oid, type);
    }
  }
  return idx;
}

export function parseBuilds(raw: unknown): Build[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const presets = (record.LoadOutPresets as { NORMAL?: unknown })?.NORMAL;
  if (!Array.isArray(presets)) return [];

  const idx = idIndex(record);
  const resolve = (slot: unknown): string | null => {
    const oid = (slot as Slot)?.ItemId?.$oid;
    return oid ? (idx.get(oid) ?? null) : null;
  };

  return presets.map((p) => {
    const preset = p as Record<string, unknown>;
    return {
      name: typeof preset.n === "string" && preset.n ? preset.n : "Unnamed",
      favorite: preset.Favorite === true,
      soul: resolve(preset.s),
      ranged: resolve(preset.l),
      melee: resolve(preset.m),
    };
  });
}
