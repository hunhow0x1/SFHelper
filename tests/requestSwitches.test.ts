import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { getSettings, updateSettings } from "../src/server/settings";
import { recordRequest } from "../src/server/requestLog";
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
const HOUR = 3600_000;
const FIXTURE = join(import.meta.dirname, "fixtures", "profile.sample.json");

describe("requests to Soulframe", () => {
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
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-switch-"));
    outside = [];
    game.open = false;
  });

  it("switches are all on until turned off, and ignore anything but true or false", async () => {
    expect(await getSettings()).toMatchObject({ inventoryRequests: true, avakotRequests: true, profileRequests: true });
    await updateSettings({ avakotRequests: false, profileRequests: "off" });
    expect(await getSettings()).toMatchObject({ inventoryRequests: true, avakotRequests: false, profileRequests: true });
  });

  it("lists when each kind was last sent, and how many went out in the last 24 hours", async () => {
    const now = Date.now();
    await recordRequest({ at: new Date(now - 25 * HOUR).toISOString(), kind: "inventory", status: 200, ms: 1, bytes: 1 });
    await recordRequest({ at: new Date(now - 4 * 60_000).toISOString(), kind: "inventory", status: 200, ms: 1, bytes: 1 });
    await recordRequest({ at: new Date(now - 2 * 60_000).toISOString(), kind: "inventory", status: 403, ms: 1, bytes: 0 });
    await updateSettings({ inventoryRequests: false });
    const r = await json("/api/requests");
    expect(r.switches).toEqual({ inventoryRequests: false, avakotRequests: true, profileRequests: true });
    expect(r.kinds).toEqual({ inventory: { last: new Date(now - 2 * 60_000).toISOString(), status: 403, empty: false, count: 2 } });
  });

  it("shows the saved profile without asking Soulframe while profile checks are off", async () => {
    game.open = true;
    await saveProfile(ACCOUNT);
    await updateSettings({ profileRequests: false });
    expect(await json(`/api/profile?accountId=${ACCOUNT}`)).toMatchObject({ profileOff: true, profileError: null });
    expect(outside).toEqual([]);
  });

  it("says so, rather than asking, when profile checks are off and nothing is saved", async () => {
    game.open = true;
    await updateSettings({ profileRequests: false });
    const res = await get(`/api/profile?accountId=${ACCOUNT}`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Profile checks are off/);
    expect(outside).toEqual([]);
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

  it("tells the Avakot tab whether stock checks can run", async () => {
    await updateSettings({ inventoryRequests: false });
    expect((await json("/api/avakot")).checks).toEqual({ avakot: true, inventory: false });
  });
});
