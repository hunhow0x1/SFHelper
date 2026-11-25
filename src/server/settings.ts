// The desktop app's settings file. Every field is validated on read and on
// update; a malformed field falls back to its default instead of failing the
// whole file.

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
  forgeNotify: boolean;
  hideFounders: boolean;
  temperPlans: Record<string, (string | null)[]>;
  temperPlanAutoRemove: boolean;
  theme: Theme | null;
}

export const TEMPER_PLAN_SLOTS = 8;

export const THEME_COLORS = ["bg", "panel", "text", "accent", "accent2"] as const;
// Colours for single parts of the window, each overriding the one worked out
// from the five theme colours.
export const THEME_PARTS = ["muted", "faint", "line", "frame", "accentHi", "accent2Hi", "button", "onAccent", "barBg", "winbar", "scroll"] as const;
export const TEXT_SIZES = [0.9, 1, 1.12, 1.25] as const;

export interface ThemeEffects {
  glow: number;
  grain: boolean;
  brackets: boolean;
}

export interface ThemeText {
  size: number;
  headings: "display" | "plain";
  body: "default" | "system";
}

export interface Theme {
  preset: string;
  colors: Record<(typeof THEME_COLORS)[number], string>;
  titleBar: { color: string; symbolColor: string };
  parts?: Partial<Record<(typeof THEME_PARTS)[number], string>>;
  effects?: ThemeEffects;
  text?: ThemeText;
}

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
  forgeNotify: true,
  hideFounders: false,
  temperPlans: {},
  temperPlanAutoRemove: false,
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
  const out: Theme = {
    preset: t.preset,
    colors: Object.fromEntries(THEME_COLORS.map((k) => [k, (colors[k] as string).toLowerCase()])) as Theme["colors"],
    titleBar: { color: bar.color.toLowerCase(), symbolColor: bar.symbolColor.toLowerCase() },
  };
  const parts = t.parts && typeof t.parts === "object" ? (t.parts as Record<string, unknown>) : {};
  const picked = THEME_PARTS.filter((k) => typeof parts[k] === "string" && HEX.test(parts[k] as string));
  if (picked.length) out.parts = Object.fromEntries(picked.map((k) => [k, (parts[k] as string).toLowerCase()]));
  const fx = t.effects && typeof t.effects === "object" ? (t.effects as Record<string, unknown>) : null;
  if (fx) {
    const glow = typeof fx.glow === "number" && Number.isFinite(fx.glow) ? Math.round(Math.min(2, Math.max(0, fx.glow)) * 20) / 20 : 1;
    out.effects = { glow, grain: fx.grain !== false, brackets: fx.brackets !== false };
  }
  const tx = t.text && typeof t.text === "object" ? (t.text as Record<string, unknown>) : null;
  if (tx) {
    out.text = {
      size: TEXT_SIZES.find((n) => n === tx.size) ?? 1,
      headings: tx.headings === "plain" ? "plain" : "display",
      body: tx.body === "system" ? "system" : "default",
    };
  }
  return out;
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

function temperPlans(v: unknown): Record<string, (string | null)[]> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 500) return null;
  const out: Record<string, (string | null)[]> = {};
  for (const [id, slots] of entries) {
    if (!/^[0-9a-f]{24}$/i.test(id) || !Array.isArray(slots) || slots.length > TEMPER_PLAN_SLOTS) return null;
    if (!slots.every((t) => t === null || (typeof t === "string" && /^\w{1,80}$/.test(t)))) return null;
    if (slots.some((t) => t !== null)) out[id] = slots as (string | null)[];
  }
  return out;
}

const settingsPath = () => appFile("settings.json");

export async function getSettings(): Promise<Settings> {
  try {
    const s = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<Settings>;
    return {
      moonsteelNotify: typeof s.moonsteelNotify === "boolean" ? s.moonsteelNotify : DEFAULTS.moonsteelNotify,
      avakotNotify: typeof s.avakotNotify === "boolean" ? s.avakotNotify : DEFAULTS.avakotNotify,
      avakotResetNotify: typeof s.avakotResetNotify === "boolean" ? s.avakotResetNotify : DEFAULTS.avakotResetNotify,
      avakotWatch: itemTypes(s.avakotWatch) ?? [],
      timerNotify: typeof s.timerNotify === "boolean" ? s.timerNotify : DEFAULTS.timerNotify,
      timerWatch: timerTags(s.timerWatch) ?? [],
      blessedNotify: typeof s.blessedNotify === "boolean" ? s.blessedNotify : DEFAULTS.blessedNotify,
      recipeNotify: typeof s.recipeNotify === "boolean" ? s.recipeNotify : DEFAULTS.recipeNotify,
      recipeWatch: itemTypes(s.recipeWatch) ?? [],
      forgeNotify: typeof s.forgeNotify === "boolean" ? s.forgeNotify : DEFAULTS.forgeNotify,
      hideFounders: typeof s.hideFounders === "boolean" ? s.hideFounders : DEFAULTS.hideFounders,
      temperPlans: temperPlans(s.temperPlans) ?? {},
      temperPlanAutoRemove: typeof s.temperPlanAutoRemove === "boolean" ? s.temperPlanAutoRemove : DEFAULTS.temperPlanAutoRemove,
      theme: theme(s.theme),
    };
  } catch {
    return { ...DEFAULTS, avakotWatch: [], timerWatch: [], recipeWatch: [], temperPlans: {} };
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
    if (typeof patch.forgeNotify === "boolean") s.forgeNotify = patch.forgeNotify;
    if (typeof patch.hideFounders === "boolean") s.hideFounders = patch.hideFounders;
    if (typeof patch.temperPlanAutoRemove === "boolean") s.temperPlanAutoRemove = patch.temperPlanAutoRemove;
    const avakotWatch = itemTypes(patch.avakotWatch);
    if (avakotWatch) s.avakotWatch = avakotWatch;
    const timerWatch = timerTags(patch.timerWatch);
    if (timerWatch) s.timerWatch = timerWatch;
    const recipeWatch = itemTypes(patch.recipeWatch);
    if (recipeWatch) s.recipeWatch = recipeWatch;
    const plans = temperPlans(patch.temperPlans);
    if (plans) s.temperPlans = plans;
    if (patch.theme === null) s.theme = null;
    else if (patch.theme !== undefined) s.theme = theme(patch.theme) ?? s.theme;
    await writeFileAtomic(settingsPath(), `${JSON.stringify(s, null, 2)}\n`);
    for (const fn of listeners) try { fn(s); } catch {}
    return s;
  });
  queue = run.catch(() => undefined);
  return run;
}
