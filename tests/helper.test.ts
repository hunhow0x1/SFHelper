import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMaps, ReadOnlyMemory } from "../helper/memoryReader";
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

describe("memory scan (Windows-like reads)", () => {
  // Regions separated by uncommitted gaps; a read that crosses a region's end
  // fails outright, as ReadProcessMemory does with ERROR_PARTIAL_COPY.
  function fakeMemory(): ReadOnlyMemory {
    const regions: { start: number; end: number; perms: string; path: null; data: Buffer }[] = [];
    let base = 0x10000;
    for (const size of [64 * 1024, 200 * 1024, 3 * 1024 * 1024]) {
      regions.push({ start: base, end: base + size, perms: "rw-p", path: null, data: Buffer.alloc(size, 0x2e) });
      base += size + 0x10000;
    }
    regions[0]!.data.write("accountId=0123456789abcdef01234567", 1000, "latin1"); // small region
    const r1 = regions[1]!;
    r1.data.write("accountId=aaaaaaaaaaaaaaaaaaaaaaaa", r1.data.length - 34, "latin1"); // flush with region end
    regions[2]!.data.write("accountId=bbbbbbbbbbbbbbbbbbbbbbbb", (1 << 20) - 5, "latin1"); // across a 1 MiB chunk
    const backend = {
      pid: 1,
      regions,
      async read(addr: number, len: number) {
        const r = regions.find((x) => addr >= x.start && addr < x.end);
        if (!r || addr + len > r.end) throw new Error("partial copy");
        return Buffer.from(r.data.subarray(addr - r.start, addr - r.start + len));
      },
      async close() {},
    };
    return Object.assign(Object.create(ReadOnlyMemory.prototype), { backend }) as ReadOnlyMemory;
  }

  it("finds needles in small regions, at region ends and across chunk boundaries, with full trailing context", async () => {
    const hits = await fakeMemory().scan(Buffer.from("accountId=", "latin1"), { trailingBytes: 24 });
    expect(hits.map((h) => h.trailing.toString("latin1"))).toEqual([
      "0123456789abcdef01234567",
      "aaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
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
