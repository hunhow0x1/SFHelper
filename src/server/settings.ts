/** App preferences, kept in the user's config dir (settings.json). */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { appFile } from "./paths";

export interface Settings {
  /** Raise a desktop notification when a Moonsteel weapon is acquired. */
  moonsteelNotify: boolean;
}

const DEFAULTS: Settings = { moonsteelNotify: true };

const settingsPath = () => appFile("settings.json");

export async function getSettings(): Promise<Settings> {
  try {
    const s = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<Settings>;
    return { moonsteelNotify: typeof s.moonsteelNotify === "boolean" ? s.moonsteelNotify : DEFAULTS.moonsteelNotify };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Merge known, correctly-typed fields from `patch` and save. Unknown fields are ignored. */
export async function updateSettings(patch: Record<string, unknown>): Promise<Settings> {
  const s = await getSettings();
  if (typeof patch.moonsteelNotify === "boolean") s.moonsteelNotify = patch.moonsteelNotify;
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(s, null, 2)}\n`);
  return s;
}
