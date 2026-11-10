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
