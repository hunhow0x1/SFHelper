import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { rankNonceCandidates } from "../helper/nonceLocator";
import type { ScanHit } from "../helper/memoryReader";

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
    expect(result.code).toBe(4);
  });

  it("doesn't try a nonce from a previous game process", async () => {
    const { result } = await run({ pid: 1111, accountId: ACCOUNT, nonce: "123456789" }, '{"Inventory":1}');
    expect(fetchCalls).toHaveLength(0);
    expect(ReadOnlyMemory.open).toHaveBeenCalledWith(4242);
    expect(result.code).toBe(4);
  });
});

const REGION = { start: 0, end: 1 << 20, perms: "rw-p", path: "" };
const hits = (...texts: string[]): ScanHit[] => texts.map((t, i) => ({ region: REGION, address: i, trailing: Buffer.from(t, "latin1") }) as ScanHit);

describe("finding the session nonce in the game's memory", () => {
  it("ranks the token the game keeps putting in its request addresses first", () => {
    const ranked = rankNonceCandidates(
      hits(`&nonce=4826419283746&ct=STEAM`, `\0\0\0 1794288958707 0 ${ACCOUNT}`),
      hits("4826419283746&ct=STEAM", "4826419283746\0", "1111111111111&ct=STEAM"),
      hits('":"9999999999"', "=4826419283746&ct"),
      ACCOUNT,
    );
    expect(ranked.map((c) => [c.token, c.form, c.seen])).toEqual([
      ["4826419283746", "address", 4],
      ["1111111111111", "address", 1],
      ["9999999999", "field", 1],
      ["1794288958707", "nearby", 1],
    ]);
  });

  it("ignores numbers that only happen to follow the markers", () => {
    expect(rankNonceCandidates([], hits("&ts=1794288958707"), hits(" is not 123456789"), ACCOUNT)).toEqual([]);
  });
});

describe("trying nonce candidates", () => {
  let dir: string;
  let tried: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfhelper-nonce-"));
    await recordConsent(join(dir, "consent.json"), ACK_PHRASE);
    await writeFile(join(dir, "config.json"), JSON.stringify({ accountId: ACCOUNT }));
    tried = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const nonce = new URL(url).searchParams.get("nonce")!;
      tried.push(nonce);
      return new Response(nonce === "2222222222222" ? '{"Inventory":1}' : "", { status: 200 });
    });
    const mem = {
      scanRegions: () => [REGION],
      scanMany: async () => [hits(), hits("1111111111111&a", "1111111111111&b", "1111111111111&c", "2222222222222&a"), hits()],
      close: async () => {},
    };
    vi.mocked(ReadOnlyMemory.open).mockResolvedValue(mem as unknown as ReadOnlyMemory);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(ReadOnlyMemory.open).mockReset();
    vi.mocked(ReadOnlyMemory.open).mockRejectedValue(new Error("no memory in tests"));
  });

  const run = () =>
    importInventory({ out: join(dir, "inventory.json"), configPath: join(dir, "config.json"), consentPath: join(dir, "consent.json") });

  it("sends one candidate per import, and never one the server already turned down", async () => {
    const first = await run();
    expect(first).toMatchObject({ ok: false, code: 7 });
    expect(tried).toEqual(["1111111111111"]);
    const second = await run();
    expect(second.ok).toBe(true);
    expect(tried).toEqual(["1111111111111", "2222222222222"]);
    expect(second.session).toMatchObject({ pid: 4242, nonce: "2222222222222" });
  });
});

describe("data paths", () => {
  it("follow SFHELPER_HOME when it is set after import (as the desktop app does)", async () => {
    const before = process.env.SFHELPER_HOME;
    try {
      const home = await mkdtemp(join(tmpdir(), "sfhelper-home-"));
      process.env.SFHELPER_HOME = home;
      expect(appFile("inventory.json")).toBe(join(home, "inventory.json"));
      await updateSettings({ moonsteelNotify: false });
      expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toMatchObject({ moonsteelNotify: false });
    } finally {
      if (before === undefined) delete process.env.SFHELPER_HOME;
      else process.env.SFHELPER_HOME = before;
    }
  });
});
