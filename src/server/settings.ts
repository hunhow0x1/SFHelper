import { readFile } from "node:fs/promises";
import { appFile } from "./paths";
import { writeFileAtomic } from "./files";

export interface Settings {
  moonsteelNotify: boolean;
  avakotNotify: boolean;
  avakotResetNotify: boolean;
  avakotWatch: string[];
  timerNotify: boolean;
  timerWatch: string[];
  blessedNotify: boolean;
  recipeNotify: boolean;
  recipeWatch: string[];
  inventoryRequests: boolean;
  avakotRequests: boolean;
  profileRequests: boolean;
}

export const REQUEST_SWITCHES = ["inventoryRequests", "avakotRequests", "profileRequests"] as const;

const DEFAULTS: Settings = {
  moonsteelNotify: true,
  avakotNotify: true,
  avakotResetNotify: false,
  avakotWatch: [],
  timerNotify: true,
  timerWatch: [],
  blessedNotify: false,
  recipeNotify: true,
  recipeWatch: [],
  inventoryRequests: true,
  avakotRequests: true,
  profileRequests: true,
};

function storeItems(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 200) return null;
  if (!v.every((p) => typeof p === "string" && p.length <= 200 && p.startsWith("/SF/"))) return null;
  return [...new Set(v as string[])];
}

function timerTags(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 200) return null;
  if (!v.every((t) => typeof t === "string" && /^[\w-]{1,120}$/.test(t))) return null;
  return [...new Set(v as string[])];
}

const settingsPath = () => appFile("settings.json");

export async function getSettings(): Promise<Settings> {
  try {
    const s = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<Settings>;
    return {
      moonsteelNotify: typeof s.moonsteelNotify === "boolean" ? s.moonsteelNotify : DEFAULTS.moonsteelNotify,
      avakotNotify: typeof s.avakotNotify === "boolean" ? s.avakotNotify : DEFAULTS.avakotNotify,
      avakotResetNotify: typeof s.avakotResetNotify === "boolean" ? s.avakotResetNotify : DEFAULTS.avakotResetNotify,
      avakotWatch: storeItems(s.avakotWatch) ?? [],
      timerNotify: typeof s.timerNotify === "boolean" ? s.timerNotify : DEFAULTS.timerNotify,
      timerWatch: timerTags(s.timerWatch) ?? [],
      blessedNotify: typeof s.blessedNotify === "boolean" ? s.blessedNotify : DEFAULTS.blessedNotify,
      recipeNotify: typeof s.recipeNotify === "boolean" ? s.recipeNotify : DEFAULTS.recipeNotify,
      recipeWatch: storeItems(s.recipeWatch) ?? [],
      inventoryRequests: typeof s.inventoryRequests === "boolean" ? s.inventoryRequests : DEFAULTS.inventoryRequests,
      avakotRequests: typeof s.avakotRequests === "boolean" ? s.avakotRequests : DEFAULTS.avakotRequests,
      profileRequests: typeof s.profileRequests === "boolean" ? s.profileRequests : DEFAULTS.profileRequests,
    };
  } catch {
    return { ...DEFAULTS, avakotWatch: [], timerWatch: [], recipeWatch: [] };
  }
}

let queue: Promise<unknown> = Promise.resolve();

export function updateSettings(patch: Record<string, unknown>): Promise<Settings> {
  const run = queue.then(async () => {
    const s = await getSettings();
    if (typeof patch.moonsteelNotify === "boolean") s.moonsteelNotify = patch.moonsteelNotify;
    if (typeof patch.avakotNotify === "boolean") s.avakotNotify = patch.avakotNotify;
    if (typeof patch.avakotResetNotify === "boolean") s.avakotResetNotify = patch.avakotResetNotify;
    if (typeof patch.timerNotify === "boolean") s.timerNotify = patch.timerNotify;
    if (typeof patch.blessedNotify === "boolean") s.blessedNotify = patch.blessedNotify;
    if (typeof patch.recipeNotify === "boolean") s.recipeNotify = patch.recipeNotify;
    for (const key of REQUEST_SWITCHES) {
      const v = patch[key];
      if (typeof v === "boolean") s[key] = v;
    }
    const watch = storeItems(patch.avakotWatch);
    if (watch) s.avakotWatch = watch;
    const timerWatch = timerTags(patch.timerWatch);
    if (timerWatch) s.timerWatch = timerWatch;
    const recipeWatch = storeItems(patch.recipeWatch);
    if (recipeWatch) s.recipeWatch = recipeWatch;
    await writeFileAtomic(settingsPath(), `${JSON.stringify(s, null, 2)}\n`);
    return s;
  });
  queue = run.catch(() => undefined);
  return run;
}
