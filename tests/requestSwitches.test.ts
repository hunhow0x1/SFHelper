import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { getSettings, updateSettings } from "../src/server/settings";
import { recordRequest } from "../src/server/requestLog";
import { snapshotFromProfile } from "../src/account/providers/profilePayload";

const ACCOUNT = "0123456789abcdef01234567";
const HOUR = 3600_000;

describe("switches for each kind of request to Soulframe", () => {
  let server: RunningServer;
  let outside: string[] = [];
  const realFetch = globalThis.fetch;
  const get = (path: string) => realFetch(`${server.url}${path}`);
  const json = async (path: string) => (await (await get(path)).json()) as Record<string, unknown>;

  beforeAll(async () => {
    server = await startServer(0);
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(server.url)) {
        outside.push(url);
        throw new Error("No network in tests.");
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    server.close();
  });
  beforeEach(async () => {
    process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-switch-"));
    outside = [];
  });

  it("are all on until turned off, and ignore anything but true or false", async () => {
    expect(await getSettings()).toMatchObject({ inventoryRequests: true, avakotRequests: true, profileRequests: true });
    await updateSettings({ avakotRequests: false, profileRequests: "off" });
    expect(await getSettings()).toMatchObject({ inventoryRequests: true, avakotRequests: false, profileRequests: true });
  });

  it("list when each kind was last sent, and how many went out in the last 24 hours", async () => {
    const now = Date.now();
    await recordRequest({ at: new Date(now - 25 * HOUR).toISOString(), kind: "inventory", status: 200, ms: 1, bytes: 1 });
    await recordRequest({ at: new Date(now - 4 * 60_000).toISOString(), kind: "inventory", status: 200, ms: 1, bytes: 1 });
    await recordRequest({ at: new Date(now - 2 * 60_000).toISOString(), kind: "inventory", status: 403, ms: 1, bytes: 0 });
    await updateSettings({ inventoryRequests: false });
    const r = await json("/api/requests");
    expect(r.switches).toEqual({ inventoryRequests: false, avakotRequests: true, profileRequests: true });
    expect(r.kinds).toEqual({ inventory: { last: new Date(now - 2 * 60_000).toISOString(), status: 403, empty: false, count: 2 } });
  });

  it("show the saved profile without asking Soulframe while profile checks are off", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dirname, "fixtures", "profile.sample.json"), "utf8"));
    const snapshot = snapshotFromProfile(fixture, "2026-11-09T12:00:00.000Z");
    await writeFile(join(process.env.SFHELPER_HOME!, `profile-${ACCOUNT}.json`), JSON.stringify({ snapshot }));
    await updateSettings({ profileRequests: false });
    const data = await json(`/api/profile?accountId=${ACCOUNT}`);
    expect(data).toMatchObject({ profileOff: true, profileError: null });
    expect(outside).toEqual([]);
  });

  it("say so, rather than asking, when profile checks are off and nothing is saved", async () => {
    await updateSettings({ profileRequests: false });
    const res = await get(`/api/profile?accountId=${ACCOUNT}`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Profile checks are off/);
    expect(outside).toEqual([]);
  });

  it("tell the Avakot tab whether stock checks can run", async () => {
    await updateSettings({ inventoryRequests: false });
    expect((await json("/api/avakot")).checks).toEqual({ avakot: true, inventory: false });
  });
});
