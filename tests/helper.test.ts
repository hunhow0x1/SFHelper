import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMaps } from "../helper/memoryReader";
import { ACK_PHRASE, readConsent, recordConsent, requireConsent } from "../helper/consent";

describe("memory maps parsing", () => {
  const maps = [
    "5566aabb0000-5566aabb1000 r--p 00000000 08:02 131 /games/Soulframe.x64.exe",
    "5566aabb1000-5566aabb2000 rw-p 00001000 08:02 131 [heap]",
    "7f0000000000-7f0000001000 ---p 00000000 00:00 0",
    "7f1111111000-7f1111112000 r-xp 00000000 08:02 99 /usr/lib/libc.so.6",
  ].join("\n");

  it("keeps readable regions and drops non-readable ones", () => {
    const regions = parseMaps(maps);
    expect(regions).toHaveLength(3); // the ---p guard page is dropped
    expect(regions.every((r) => r.perms[0] === "r")).toBe(true);
  });

  it("records the backing path when present", () => {
    const heap = parseMaps(maps).find((r) => r.path === "[heap]");
    expect(heap?.perms).toBe("rw-p");
  });
});

describe("consent gate", () => {
  async function tmpConsentPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sfhelper-consent-"));
    return join(dir, "consent.json");
  }

  it("refuses to scan with no consent on disk", async () => {
    const path = await tmpConsentPath();
    await expect(requireConsent(path)).rejects.toThrow(/not acknowledged/);
  });

  it("rejects a wrong acknowledgement phrase", async () => {
    const path = await tmpConsentPath();
    await expect(recordConsent(path, "sure whatever")).rejects.toThrow(/does not match/);
    expect(await readConsent(path)).toBeNull();
  });

  it("records and then honors the exact phrase", async () => {
    const path = await tmpConsentPath();
    await recordConsent(path, ACK_PHRASE);
    await expect(requireConsent(path)).resolves.toBeUndefined();
    const raw = JSON.parse(await readFile(path, "utf8")) as { acknowledged: boolean };
    expect(raw.acknowledged).toBe(true);
  });
});
