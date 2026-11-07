import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameDataWatcher, RETRY_MS, SETTLE_MS, type WatcherOptions } from "../src/gamedata/watch";
import type { UpdateOptions, UpdateResult } from "../src/gamedata/update";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sfh-watch-"));
  const cache = join(root, "Cache.Windows");
  const out = join(root, "data");
  await mkdir(cache, { recursive: true });
  await mkdir(out, { recursive: true });
  const T0 = Date.UTC(2026, 10, 1, 12);
  let clock = T0 + SETTLE_MS + 1;
  const touch = async (at: number, size = "x") => {
    for (const f of ["H.Misc.toc", "H.Misc_en.toc"]) {
      await writeFile(join(cache, f), size);
      await utimes(join(cache, f), at / 1000, at / 1000);
    }
  };
  await touch(T0);
  const calls = { reads: 0, updates: 0, changed: 0 };
  let hash = "h1";
  let incomplete = false;
  let dir: string | null = cache;
  const opts = (appVersion = "1.0.0"): WatcherOptions => ({
    statePath: join(root, "gamedata.json"),
    outDir: out,
    bundledDir: join(root, "public"),
    appVersion,
    locate: async () => ({ dir, build: "2026.10.08.15.20" }),
    log: () => {},
    onChanged: () => void (calls.changed += 1),
    readFiles: async () => {
      calls.reads += 1;
      return { packages: Buffer.alloc(0), languages: Buffer.alloc(0), hash };
    },
    update: async (_o: UpdateOptions): Promise<UpdateResult> => {
      calls.updates += 1;
      return { hash, changed: ["names.json"], failed: [], incomplete, drawn: 0, summary: "ok" };
    },
    now: () => clock,
  });
  return {
    root,
    out,
    calls,
    opts,
    touch,
    setHash: (h: string) => void (hash = h),
    setIncomplete: (v: boolean) => void (incomplete = v),
    setDir: (d: string | null) => void (dir = d),
    tick: (ms: number) => void (clock += ms),
    now: () => clock,
  };
}

describe("updating game data after Soulframe updates", () => {
  it("builds on first run, then only when the game files really change", async () => {
    const t = await setup();
    const w = new GameDataWatcher(t.opts());
    expect(await w.check()).toBe("updated");
    expect(t.calls).toEqual({ reads: 1, updates: 1, changed: 1 });

    expect(await w.check()).toBe("current");
    expect(t.calls.reads).toBe(1);

    await t.touch(t.now() - SETTLE_MS - 1, "xy");
    expect(await w.check()).toBe("same-files");
    expect(t.calls.updates).toBe(1);
    expect(await w.check()).toBe("current");

    await t.touch(t.now() - 1000, "xyz");
    t.setHash("h2");
    expect(await w.check()).toBe("settling");
    t.tick(SETTLE_MS);
    expect(await w.check()).toBe("updated");
    expect(t.calls.updates).toBe(2);
    expect(JSON.parse(await readFile(join(t.root, "gamedata.json"), "utf8"))).toMatchObject({ app: "1.0.0", hash: "h2", complete: true });
  });

  it("rebuilds after an app update and retries an incomplete run a day later", async () => {
    const t = await setup();
    t.setIncomplete(true);
    expect(await new GameDataWatcher(t.opts()).check()).toBe("updated");
    t.setIncomplete(false);
    expect(await new GameDataWatcher(t.opts()).check()).toBe("current");
    t.tick(RETRY_MS + 1);
    expect(await new GameDataWatcher(t.opts()).check()).toBe("updated");
    expect(await new GameDataWatcher(t.opts()).check()).toBe("current");
    expect(await new GameDataWatcher(t.opts("1.0.1")).check()).toBe("updated");
    expect(t.calls.updates).toBe(3);
  });

  it("drops the previous version's copies before rebuilding them", async () => {
    const t = await setup();
    expect(await new GameDataWatcher(t.opts()).check()).toBe("updated");
    await writeFile(join(t.out, "upgrades.json"), "{}");
    await mkdir(join(t.out, "img", "items"), { recursive: true });
    await writeFile(join(t.out, "img", "items", "old.png"), "");
    expect(await new GameDataWatcher(t.opts("1.0.1")).check()).toBe("updated");
    await expect(readFile(join(t.out, "upgrades.json"))).rejects.toThrow();
    await expect(readFile(join(t.out, "img", "items", "old.png"))).rejects.toThrow();
  });

  it("drops its copies when the app updates and the game can't be found", async () => {
    const t = await setup();
    expect(await new GameDataWatcher(t.opts()).check()).toBe("updated");
    await writeFile(join(t.out, "names.json"), "{}");
    await writeFile(join(t.out, "weapons.json"), "{}");
    t.setDir(null);
    expect(await new GameDataWatcher(t.opts()).check()).toBe("no-game");
    expect(await new GameDataWatcher(t.opts("1.0.1")).check()).toBe("cleared");
    await expect(readFile(join(t.out, "names.json"))).rejects.toThrow();
    expect(await readFile(join(t.out, "weapons.json"), "utf8")).toBe("{}");
    expect(t.calls.changed).toBe(2);
  });

  it("reports a failure once and keeps going", async () => {
    const t = await setup();
    const logs: string[] = [];
    const w = new GameDataWatcher({ ...t.opts(), log: (m) => logs.push(m), readFiles: async () => Promise.reject(new Error("EBUSY")) });
    expect(await w.check()).toBe("failed");
    expect(await w.check()).toBe("failed");
    expect(logs.filter((l) => l.includes("EBUSY"))).toHaveLength(1);
  });
});
