/** Read-only access to a running process's memory on Linux.
 *
 *  This module NEVER writes. It opens /proc/<pid>/mem with the "r" flag only,
 *  exposes no write method, and holds no writable handle. That is a hard,
 *  structural guarantee, not a convention: there is nothing in this file that
 *  could modify the target process even if called incorrectly.
 *
 *  It lives outside src/ on purpose. The main app's provider registry rejects
 *  anything that touches the game process; this helper is a separate program
 *  whose only output is a JSON file the app later imports.
 */

import { open, readFile, type FileHandle } from "node:fs/promises";

export interface MemoryRegion {
  start: number;
  end: number;
  /** Permission string from /proc/<pid>/maps, e.g. "rw-p". */
  perms: string;
  /** Backing path if the region is file-backed (e.g. the mapped exe). */
  path: string | null;
}

/** Parse /proc/<pid>/maps into the readable, writable, anonymous regions that
 *  could hold session state. We only ever READ these; "writable" here means
 *  "the game can write to it", i.e. where mutable data like a nonce lives. */
export function parseMaps(maps: string): MemoryRegion[] {
  const regions: MemoryRegion[] = [];
  for (const line of maps.split("\n")) {
    // Format: 5566aabb-5566ccdd rw-p 00000000 00:00 0    [heap]
    const match = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S{4})\s+\S+\s+\S+\s+\S+\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, startHex, endHex, perms, rest] = match;
    if (!startHex || !endHex || !perms) continue;
    // Only regions the process can read. Skip guard pages and non-readable maps.
    if (perms[0] !== "r") continue;
    regions.push({
      start: Number.parseInt(startHex, 16),
      end: Number.parseInt(endHex, 16),
      perms,
      path: rest && rest.trim() !== "" ? rest.trim() : null,
    });
  }
  return regions;
}

export interface ScanHit {
  region: MemoryRegion;
  /** Absolute address where the needle was found. */
  address: number;
  /** Bytes captured immediately after the needle, for the locator to inspect. */
  trailing: Buffer;
}

export interface ScanOptions {
  trailingBytes?: number;
  maxHits?: number;
  /** Scan every readable region, not just writable anonymous ones (slow). */
  allRegions?: boolean;
  /** Called with (bytesScanned, bytesTotal) as the scan advances. */
  onProgress?: ((scanned: number, total: number) => void) | undefined;
}

/** A strictly read-only view of one process. Construct via {@link openProcess}. */
export class ReadOnlyMemory {
  private constructor(
    readonly pid: number,
    private readonly handle: FileHandle,
    readonly regions: MemoryRegion[],
  ) {}

  /** Open /proc/<pid>/mem read-only and load its map. Throws if the process is
   *  gone or not readable (needs matching uid or ptrace scope). */
  static async open(pid: number): Promise<ReadOnlyMemory> {
    const maps = await readFile(`/proc/${pid}/maps`, "utf8");
    // "r" — read-only. This handle can never be used to write.
    const handle = await open(`/proc/${pid}/mem`, "r");
    return new ReadOnlyMemory(pid, handle, parseMaps(maps));
  }

  /** Read a slice of the target's address space. Read-only. */
  async read(address: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    // position = address: pread-style, no seek, no write.
    await this.handle.read(buf, 0, length, address);
    return buf;
  }

  /** Regions worth scanning for live session data (the nonce, the account id).
   *  That data lives in the heap/anonymous WRITABLE memory - never in the
   *  gigabytes of read-only, file-backed texture/code mappings - so restricting
   *  to writable anonymous regions cuts the scan from GBs to ~tens of MB. */
  scanRegions(): MemoryRegion[] {
    return this.regions.filter(
      (r) => r.perms[1] === "w" && (r.path === null || r.path.startsWith("[")),
    );
  }

  /** Search for a byte pattern, capturing trailing bytes so a caller can pull an
   *  adjacent value (e.g. a nonce right after a key). By default scans only the
   *  writable anonymous regions and reports progress so long scans are visible. */
  async scan(needle: Buffer, opts: ScanOptions = {}): Promise<ScanHit[]> {
    const trailingBytes = opts.trailingBytes ?? 64;
    const maxHits = opts.maxHits ?? 32;
    const regions = opts.allRegions ? this.regions : this.scanRegions();
    const total = regions.reduce((n, r) => n + (r.end - r.start), 0);
    const hits: ScanHit[] = [];
    const CHUNK = 1 << 20; // 1 MiB
    let scanned = 0;
    for (const region of regions) {
      for (let addr = region.start; addr < region.end; addr += CHUNK) {
        const size = Math.min(CHUNK, region.end - addr);
        let buf: Buffer;
        try {
          buf = await this.read(addr, size + trailingBytes);
        } catch {
          break; // region became unreadable (process moved on); skip it
        }
        let idx = buf.indexOf(needle);
        while (idx !== -1 && idx < size) {
          hits.push({
            region,
            address: addr + idx,
            trailing: buf.subarray(idx + needle.length, idx + needle.length + trailingBytes),
          });
          if (hits.length >= maxHits) return hits;
          idx = buf.indexOf(needle, idx + 1);
        }
        scanned += size;
        opts.onProgress?.(scanned, total);
      }
    }
    return hits;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
