/** App preferences, kept in the user's config dir (settings.json). */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { appFile } from "./paths";

export interface Settings {
  /** Raise a desktop notification when a Moonsteel weapon is acquired. */
  moonsteelNotify: boolean;
  /** Raise one when Avakot stocks a starred item. */
  avakotNotify: boolean;
  /** Avakot's store items (StoreItem paths) the user starred. */
  avakotWatch: string[];
}

const DEFAULTS: Settings = { moonsteelNotify: true, avakotNotify: true, avakotWatch: [] };

/** A list of store item paths, deduplicated; null if it isn't one. */
function storeItems(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 200) return null;
  if (!v.every((p) => typeof p === "string" && p.length <= 200 && p.startsWith("/SF/"))) return null;
  return [...new Set(v as string[])];
}

const settingsPath = () => appFile("settings.json");

export async function getSettings(): Promise<Settings> {
  try {
    const s = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<Settings>;
    return {
      moonsteelNotify: typeof s.moonsteelNotify === "boolean" ? s.moonsteelNotify : DEFAULTS.moonsteelNotify,
      avakotNotify: typeof s.avakotNotify === "boolean" ? s.avakotNotify : DEFAULTS.avakotNotify,
      avakotWatch: storeItems(s.avakotWatch) ?? [],
    };
  } catch {
    return { ...DEFAULTS, avakotWatch: [] };
  }
}

/** Merge known, correctly-typed fields from `patch` and save. Unknown fields are ignored. */
export async function updateSettings(patch: Record<string, unknown>): Promise<Settings> {
  const s = await getSettings();
  if (typeof patch.moonsteelNotify === "boolean") s.moonsteelNotify = patch.moonsteelNotify;
  if (typeof patch.avakotNotify === "boolean") s.avakotNotify = patch.avakotNotify;
  const watch = storeItems(patch.avakotWatch);
  if (watch) s.avakotWatch = watch;
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(s, null, 2)}\n`);
  return s;
}
