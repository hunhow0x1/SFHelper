import { readFile } from "node:fs/promises";
import { appFile } from "./paths";
import { writeFileAtomic } from "./files";

export interface Settings {
  moonsteelNotify: boolean;
  timerNotify: boolean;
  timerWatch: string[];
  blessedNotify: boolean;
  recipeNotify: boolean;
  recipeWatch: string[];
  theme: Theme | null;
}

export const THEME_COLORS = ["bg", "panel", "text", "accent", "accent2"] as const;

export interface Theme {
  preset: string;
  colors: Record<(typeof THEME_COLORS)[number], string>;
  titleBar: { color: string; symbolColor: string };
}

const DEFAULTS: Settings = {
  moonsteelNotify: true,
  timerNotify: true,
  timerWatch: [],
  blessedNotify: false,
  recipeNotify: true,
  recipeWatch: [],
  theme: null,
};

const HEX = /^#[0-9a-f]{6}$/i;

function theme(v: unknown): Theme | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  const colors = t.colors as Record<string, unknown> | undefined;
  const bar = t.titleBar as Record<string, unknown> | undefined;
  if (typeof t.preset !== "string" || !/^[a-z-]{1,24}$/.test(t.preset) || !colors || !bar) return null;
  if (!THEME_COLORS.every((k) => typeof colors[k] === "string" && HEX.test(colors[k] as string))) return null;
  if (typeof bar.color !== "string" || !HEX.test(bar.color) || typeof bar.symbolColor !== "string" || !HEX.test(bar.symbolColor)) return null;
  return {
    preset: t.preset,
    colors: Object.fromEntries(THEME_COLORS.map((k) => [k, (colors[k] as string).toLowerCase()])) as Theme["colors"],
    titleBar: { color: bar.color.toLowerCase(), symbolColor: bar.symbolColor.toLowerCase() },
  };
}

const listeners: ((s: Settings) => void)[] = [];

export function onSettingsChange(fn: (s: Settings) => void): void {
  listeners.push(fn);
}

function itemTypes(v: unknown): string[] | null {
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
      timerNotify: typeof s.timerNotify === "boolean" ? s.timerNotify : DEFAULTS.timerNotify,
      timerWatch: timerTags(s.timerWatch) ?? [],
      blessedNotify: typeof s.blessedNotify === "boolean" ? s.blessedNotify : DEFAULTS.blessedNotify,
      recipeNotify: typeof s.recipeNotify === "boolean" ? s.recipeNotify : DEFAULTS.recipeNotify,
      recipeWatch: itemTypes(s.recipeWatch) ?? [],
      theme: theme(s.theme),
    };
  } catch {
    return { ...DEFAULTS, timerWatch: [], recipeWatch: [] };
  }
}

let queue: Promise<unknown> = Promise.resolve();

export function updateSettings(patch: Record<string, unknown>): Promise<Settings> {
  const run = queue.then(async () => {
    const s = await getSettings();
    if (typeof patch.moonsteelNotify === "boolean") s.moonsteelNotify = patch.moonsteelNotify;
    if (typeof patch.timerNotify === "boolean") s.timerNotify = patch.timerNotify;
    if (typeof patch.blessedNotify === "boolean") s.blessedNotify = patch.blessedNotify;
    if (typeof patch.recipeNotify === "boolean") s.recipeNotify = patch.recipeNotify;
    const timerWatch = timerTags(patch.timerWatch);
    if (timerWatch) s.timerWatch = timerWatch;
    const recipeWatch = itemTypes(patch.recipeWatch);
    if (recipeWatch) s.recipeWatch = recipeWatch;
    if (patch.theme === null) s.theme = null;
    else if (patch.theme !== undefined) s.theme = theme(patch.theme) ?? s.theme;
    await writeFileAtomic(settingsPath(), `${JSON.stringify(s, null, 2)}\n`);
    for (const fn of listeners) try { fn(s); } catch {}
    return s;
  });
  queue = run.catch(() => undefined);
  return run;
}
