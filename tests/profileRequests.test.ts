import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { getSettings } from "../src/server/settings";
import { snapshotFromProfile } from "../src/account/providers/profilePayload";

const game = vi.hoisted(() => ({ open: false }));
vi.mock("../helper/processFinder", () => ({
  findSoulframe: async () => (game.open ? [{ pid: 4242, matchedOn: "comm" }] : []),
}));
vi.mock("../src/server/gameLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/gameLog")>()),
  gameBeingRefused: async () => null,
}));

const ACCOUNT = "0123456789abcdef01234567";
const FIXTURE = join(import.meta.dirname, "fixtures", "profile.sample.json");

describe("profile requests", () => {
  let server: RunningServer;
  let outside: string[] = [];
  let profileText = "";
  const realFetch = globalThis.fetch;
  const get = (path: string) => realFetch(`${server.url}${path}`);
  const json = async (path: string) => (await (await get(path)).json()) as Record<string, unknown>;
  const saveProfile = async (account: string) => {
    const snapshot = snapshotFromProfile(JSON.parse(profileText), "2026-11-09T12:00:00.000Z");
    await writeFile(join(process.env.SFHELPER_HOME!, `profile-${account}.json`), JSON.stringify({ snapshot }));
  };

  beforeAll(async () => {
    profileText = await readFile(FIXTURE, "utf8");
    server = await startServer(0);
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(server.url)) return realFetch(input, init);
      outside.push(url);
      if (url.includes("getProfileViewingData.php")) return new Response(profileText, { status: 200 });
      throw new Error("No network in tests.");
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    server.close();
  });
  beforeEach(async () => {
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-profile-"));
    outside = [];
    game.open = false;
  });

  it("asks for nothing while Soulframe is closed, and shows the saved profile", async () => {
    const account = "1123456789abcdef01234567";
    await saveProfile(account);
    expect(await json(`/api/profile?accountId=${account}`)).toMatchObject({ profileWaiting: true, profileError: null });
    const res = await get(`/api/profile?accountId=${"2123456789abcdef01234567"}`);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Soulframe isn't running/);
    expect(outside).toEqual([]);
  });

  it("asks for the profile once Soulframe is open", async () => {
    game.open = true;
    const account = "3123456789abcdef01234567";
    expect(await json(`/api/profile?accountId=${account}`)).toMatchObject({ profileWaiting: false, profileError: null });
    expect(outside).toEqual([`https://api.soulframe.com/cdn/getProfileViewingData.php?playerId=${account}`]);
  });

  it("ignores the old request switches, so nothing in settings.json can turn requests off", async () => {
    game.open = true;
    const account = "4123456789abcdef01234567";
    await writeFile(
      join(process.env.SFHELPER_HOME!, "settings.json"),
      JSON.stringify({ inventoryRequests: false, avakotRequests: false, profileRequests: false, avakotWatch: ["/SF/StoreItems/X"], timerNotify: false }),
    );
    const settings = await getSettings();
    expect(settings.timerNotify).toBe(false);
    for (const key of ["inventoryRequests", "avakotRequests", "profileRequests", "avakotWatch", "avakotNotify"]) expect(settings).not.toHaveProperty(key);
    expect(await json(`/api/profile?accountId=${account}`)).toMatchObject({ profileWaiting: false, profileError: null });
    expect(outside).toEqual([`https://api.soulframe.com/cdn/getProfileViewingData.php?playerId=${account}`]);
  });
});
