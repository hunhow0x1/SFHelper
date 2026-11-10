import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRequests, readRequests, recordRequest, summarizeRequests, tracked } from "../src/server/requestLog";
import { alreadyReported, recordRefusalEnd, recordRefusalStart } from "../src/server/refusalReport";
import { loggedGame, refusalDetails } from "../src/server/gameLog";
import { apiPausedUntil, noteApiAccepted, restoreApiBackoff } from "../src/server/apiBackoff";

const HOUR = 3600_000;

beforeEach(async () => {
  process.env.SFHELPER_HOME = await mkdtemp(join(tmpdir(), "sfh-diag-"));
});

const fake = (status: number, body: string, headers: Record<string, string> = {}): typeof fetch =>
  (async () => new Response(body, { status, headers })) as typeof fetch;

describe("request ledger", () => {
  it("records each request to DE without the session details, and passes the body through", async () => {
    const res = await tracked("inventory", fake(200, '{"ok":1}', { server: "AkamaiGHost" }), { attempt: 2, of: 3 })(
      "https://api.soulframe.com/api/inventory.php?accountId=abc&nonce=123",
    );
    expect(await res.text()).toBe('{"ok":1}');
    await tracked("inventory", fake(200, "{}"))("https://example.invalid/");
    await tracked("vendor", fake(403, ""))("https://example.invalid/");

    const entries = await readRequests();
    expect(entries.map((e) => [e.kind, e.status, e.empty ?? false])).toEqual([
      ["inventory", 200, false],
      ["inventory", 200, true],
      ["vendor", 403, false],
    ]);
    expect(entries[0]).toMatchObject({ attempt: 2, of: 3, bytes: 8, server: "AkamaiGHost" });
    const raw = await readFile(join(process.env.SFHELPER_HOME!, "requests.log"), "utf8");
    expect(raw).not.toContain("nonce");
    expect(raw).not.toContain("accountId");
  });

  it("records network errors too", async () => {
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    await expect(tracked("profile", failing)("https://example.invalid/")).rejects.toThrow("ECONNRESET");
    expect(await readRequests()).toMatchObject([{ kind: "profile", status: null, error: "ECONNRESET" }]);
  });

  it("keeps 30 days and sums requests by kind and outcome", async () => {
    const now = Date.parse("2026-11-10T03:00:00Z");
    await recordRequest({ at: new Date(now - 31 * 24 * HOUR).toISOString(), kind: "inventory", status: 200, ms: 1, bytes: 1 });
    await recordRequest({ at: new Date(now - HOUR).toISOString(), kind: "inventory", status: 200, ms: 1, bytes: 1 });
    await recordRequest({ at: new Date(now - HOUR + 1).toISOString(), kind: "inventory", status: 200, ms: 1, bytes: 2, empty: true });
    await recordRequest({ at: new Date(now - 60_000).toISOString(), kind: "vendor", status: 403, ms: 1, bytes: 0 });
    await pruneRequests(now);
    const kept = await readRequests(0, now);
    expect(kept).toHaveLength(3);
    expect(summarizeRequests(kept)).toMatchObject({
      total: 3,
      byKind: { inventory: { "200": 1, "200 empty": 1 }, vendor: { "403": 1 } },
      lastOk: new Date(now - HOUR).toISOString(),
    });
  });
});

describe("refusal reports", () => {
  const first = Date.parse("2026-11-10T03:06:52Z");
  const refusals = { count: 59, first, last: first + 6 * 60_000, loginRefused: false };

  it("saves what SFHelper sent in the two hours before the game was refused", async () => {
    await recordRequest({ at: new Date(first - 3 * HOUR).toISOString(), kind: "inventory", status: 200, ms: 1, bytes: 1 });
    await recordRequest({ at: new Date(first - 101_000).toISOString(), kind: "inventory", status: 200, ms: 1, bytes: 1 });
    await recordRequest({ at: new Date(first - 6 * 60_000).toISOString(), kind: "vendor", status: 200, ms: 1, bytes: 1 });
    await recordRefusalStart({
      refusals,
      details: [{ at: first, status: "403 Forbidden", server: "AkamaiGHost", before: "Hud.lua: false", after: "Stat log event upload failed:" }],
      publicAddress: "104.181.86.240",
      build: "2026.11.09.17.14",
      appVersion: "0.4.45",
      gameRunning: false,
      late: false,
    });
    const [report] = (await readFile(join(process.env.SFHELPER_HOME!, "refusals.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(report).toMatchObject({
      event: "start",
      firstRefusal: "2026-11-10T03:06:52.000Z",
      count: 59,
      game: { publicAddress: "104.181.86.240", build: "2026.11.09.17.14" },
      sfhelper: { version: "0.4.45" },
      requestsBefore: { total: 2, byKind: { inventory: { "200": 1 }, vendor: { "200": 1 } }, lastOk: new Date(first - 101_000).toISOString() },
    });
    expect(report.details[0]).toMatchObject({ server: "AkamaiGHost", before: "Hud.lua: false" });
  });

  it("reports each block once, and again if it comes back after ending", async () => {
    const ctx = { refusals, details: [], publicAddress: null, build: null, appVersion: "0.4.45", gameRunning: false, late: true };
    expect(await alreadyReported(first)).toBe(false);
    await recordRefusalStart(ctx);
    expect(await alreadyReported(first)).toBe(true);
    await recordRefusalEnd(refusals, false);
    expect(await alreadyReported(first)).toBe(false);
  });
});

describe("refusal context from the game log", () => {
  it("never copies the login email", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(
      log,
      [
        "0.049 Sys [Diag]: Current time: Mon Nov  9 22:45:38 2026 [UTC: Tue Nov 10 03:45:38 2026]",
        "32.279 Sys [Info]: Logging in as someone@example.com",
        "32.562 Sys [Warning]: HTTP/1.1 403 Forbidden",
        "32.562 Sys [Warning]: Server: AkamaiGHost",
        "32.565 Sys [Error]: Login failed: ",
        "",
      ].join("\n"),
    );
    const [d] = await refusalDetails(log);
    expect(d).toMatchObject({ server: "AkamaiGHost", before: "Logging in as [email]" });
  });
});

describe("the game's public address", () => {
  it("comes from the game's network check in its log", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "sfh-log-")), "EE.log");
    await writeFile(
      log,
      [
        "0.049 Sys [Diag]: Current time: Mon Nov  9 21:05:45 2026 [UTC: Tue Nov 10 02:05:45 2026]",
        "37.537 Net [Info]: Server test reply from 50.116.54.192:4950 (215ms, 2L), public address 104.181.86.240:4960",
        "",
      ].join("\n"),
    );
    expect(await loggedGame(log)).toMatchObject({ publicAddress: "104.181.86.240" });
  });
});

describe("SFHelper's own pause after a refusal", () => {
  it("carries over a restart, rebuilt from the request record", () => {
    const t = Date.parse("2026-11-10T04:09:18Z");
    const at = (ms: number) => new Date(ms).toISOString();
    restoreApiBackoff([{ at: at(t - HOUR), status: 200 }, { at: at(t), status: 403 }]);
    expect(apiPausedUntil(t + 60_000)).toBe(t + 15 * 60_000);
    restoreApiBackoff([{ at: at(t + 15 * 60_000), status: 403 }, { at: at(t), status: 403 }]);
    expect(apiPausedUntil(t + 20 * 60_000)).toBe(t + 45 * 60_000);
    restoreApiBackoff([{ at: at(t), status: 403 }, { at: at(t + 15 * 60_000), status: 200 }]);
    expect(apiPausedUntil(t + 16 * 60_000)).toBeNull();
    restoreApiBackoff([]);
    expect(apiPausedUntil(t)).toBeNull();
    noteApiAccepted();
  });
});
