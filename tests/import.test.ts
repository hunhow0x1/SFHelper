import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No real game process or memory: a fake Soulframe at pid 4242 whose memory
// can't be opened, so any fall-through to a scan shows up as code 4.
vi.mock("../helper/processFinder", () => ({
  findSoulframe: async () => [{ pid: 4242, matchedOn: "cmdline" }],
}));
vi.mock("../helper/memoryReader", () => ({
  ReadOnlyMemory: { open: vi.fn(async () => Promise.reject(new Error("no memory in tests"))) },
}));

import { importInventory } from "../helper/run";
import { ReadOnlyMemory } from "../helper/memoryReader";
import { ACK_PHRASE, recordConsent } from "../helper/consent";
import { appFile } from "../src/server/paths";
import { updateSettings } from "../src/server/settings";

const ACCOUNT = "0123456789abcdef01234567";

describe("repeat imports reuse the session nonce", () => {
  let dir: string;
  let fetchCalls: string[];

  async function run(session: { pid: number; accountId: string; nonce: string } | undefined, body: string) {
    vi.stubGlobal("fetch", async (url: string) => (fetchCalls.push(url), new Response(body, { status: 200 })));
    const logs: string[] = [];
    const result = await importInventory({
      out: join(dir, "inventory.json"),
      configPath: join(dir, "config.json"),
      consentPath: join(dir, "consent.json"),
      session,
      onLog: (m) => logs.push(m),
    });
    return { result, logs };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfhelper-import-"));
    await recordConsent(join(dir, "consent.json"), ACK_PHRASE);
    await writeFile(join(dir, "config.json"), JSON.stringify({ accountId: ACCOUNT }));
    fetchCalls = [];
    vi.mocked(ReadOnlyMemory.open).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the known nonce without scanning memory", async () => {
    const { result } = await run({ pid: 4242, accountId: ACCOUNT, nonce: "123456789" }, '{"Inventory":1}');
    expect(result.ok).toBe(true);
    expect(result.session).toEqual({ pid: 4242, accountId: ACCOUNT, nonce: "123456789" });
    expect(ReadOnlyMemory.open).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("nonce=123456789");
    expect(await readFile(join(dir, "inventory.json"), "utf8")).toContain("Inventory");
  });

  it("scans again when the nonce is rejected", async () => {
    const { result, logs } = await run({ pid: 4242, accountId: ACCOUNT, nonce: "123456789" }, "");
    expect(fetchCalls).toHaveLength(1);
    expect(logs.some((l) => /scanning memory again/.test(l))).toBe(true);
    expect(ReadOnlyMemory.open).toHaveBeenCalledWith(4242);
    expect(result.code).toBe(4); // the (mocked) scan couldn't open memory
  });

  it("doesn't try a nonce from a previous game process", async () => {
    const { result } = await run({ pid: 1111, accountId: ACCOUNT, nonce: "123456789" }, '{"Inventory":1}');
    expect(fetchCalls).toHaveLength(0);
    expect(ReadOnlyMemory.open).toHaveBeenCalledWith(4242);
    expect(result.code).toBe(4);
  });
});

describe("data paths", () => {
  it("follow SFHELPER_HOME when it is set after import (as the desktop app does)", async () => {
    const before = process.env.SFHELPER_HOME;
    try {
      const home = await mkdtemp(join(tmpdir(), "sfhelper-home-"));
      process.env.SFHELPER_HOME = home;
      expect(appFile("inventory.json")).toBe(join(home, "inventory.json"));
      // A module imported before the variable was set still writes there.
      await updateSettings({ moonsteelNotify: false });
      expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ moonsteelNotify: false });
    } finally {
      if (before === undefined) delete process.env.SFHELPER_HOME;
      else process.env.SFHELPER_HOME = before;
    }
  });
});
