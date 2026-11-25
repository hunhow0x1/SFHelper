import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, onSettingsChange, updateSettings, type Settings } from "../src/server/settings";

const MOONLIT = {
  preset: "moonlit",
  colors: { bg: "#0A0C10", panel: "#141922", text: "#e6eaf0", accent: "#b4c3d6", accent2: "#8cb8e0" },
  titleBar: { color: "#0e1117", symbolColor: "#b4c3d6" },
};

describe("the colour theme setting", () => {
  let home: string | undefined;
  beforeAll(async () => {
    home = process.env.SFHELPER_HOME;
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-theme-"));
  });
  afterAll(() => {
    if (home === undefined) delete process.env.SFHELPER_HOME;
    else process.env.SFHELPER_HOME = home;
  });

  it("starts on the default look", async () => {
    expect((await getSettings()).theme).toBeNull();
  });

  it("saves a theme, tells the window, and keeps other settings", async () => {
    const seen: Settings["theme"][] = [];
    onSettingsChange((s) => seen.push(s.theme));
    await updateSettings({ theme: MOONLIT, blessedNotify: true });
    const s = await getSettings();
    expect(s.theme).toEqual({ ...MOONLIT, colors: { ...MOONLIT.colors, bg: "#0a0c10" } });
    expect(s.blessedNotify).toBe(true);
    expect(seen.at(-1)?.titleBar).toEqual(MOONLIT.titleBar);
  });

  it("ignores a theme that isn't plain colours, and goes back to the default on null", async () => {
    await updateSettings({ theme: { ...MOONLIT, colors: { ...MOONLIT.colors, accent: "red; background: url(x)" } } });
    expect((await getSettings()).theme?.colors.accent).toBe("#b4c3d6");
    await updateSettings({ theme: { ...MOONLIT, titleBar: { color: "#000" } } });
    expect((await getSettings()).theme?.preset).toBe("moonlit");
    await updateSettings({ theme: null });
    expect((await getSettings()).theme).toBeNull();
  });
});

describe("theme parts, effects and text", () => {
  let home: string | undefined;
  beforeAll(async () => {
    home = process.env.SFHELPER_HOME;
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-theme-"));
  });
  afterAll(() => {
    if (home === undefined) delete process.env.SFHELPER_HOME;
    else process.env.SFHELPER_HOME = home;
  });

  it("keeps valid part colours, effects and text choices, and drops the rest", async () => {
    await updateSettings({
      theme: {
        ...MOONLIT,
        preset: "custom",
        parts: { muted: "#A0B0C0", frame: "url(x)", nope: "#ffffff" },
        effects: { glow: 3.7, grain: false, brackets: "yes" },
        text: { size: 1.12, headings: "plain", body: "comic" },
      },
    });
    const t = (await getSettings()).theme!;
    expect(t.parts).toEqual({ muted: "#a0b0c0" });
    expect(t.effects).toEqual({ glow: 2, grain: false, brackets: true });
    expect(t.text).toEqual({ size: 1.12, headings: "plain", body: "default" });
  });

  it("keeps effects and text on the Soulframe colours, and an odd size falls back to the default", async () => {
    await updateSettings({ theme: { ...MOONLIT, preset: "soulframe", effects: { glow: 0.5, grain: true, brackets: false }, text: { size: 2, headings: "display", body: "system" } } });
    const t = (await getSettings()).theme!;
    expect(t.preset).toBe("soulframe");
    expect(t.parts).toBeUndefined();
    expect(t.effects).toEqual({ glow: 0.5, grain: true, brackets: false });
    expect(t.text).toEqual({ size: 1, headings: "display", body: "system" });
  });
});
