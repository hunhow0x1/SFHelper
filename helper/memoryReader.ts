/** Strictly read-only access to a running process's memory, cross-platform.
 *
 *  This module NEVER writes. The platform backends (Linux /proc, Windows
 *  ReadProcessMemory) each open the target with read-only rights and expose no
 *  write method. The scan logic below only ever calls read(). That is a hard,
 *  structural guarantee, not a convention.
 *
 *  It lives outside src/ on purpose: the app's provider registry rejects anything
 *  that touches the game process; this helper is separate, and its only output is
 *  a JSON file the app later imports.
 */

import { openLinux, parseMaps } from "./backends/linux";
import { openWindows } from "./backends/windows";
import type { MemBackend, MemoryRegion } from "./backends/types";

export { parseMaps };
export type { MemoryRegion };

export interface ScanHit {
  region: MemoryRegion;
  address: number;
  trailing: Buffer;
}

export interface ScanOptions {
  trailingBytes?: number;
  maxHits?: number;
  /** Scan every readable region, not just writable anonymous ones (slow). */
  allRegions?: boolean;
  onProgress?: ((scanned: number, total: number) => void) | undefined;
}

/** One needle of a multi-needle scan. */
export interface ScanPattern {
  needle: Buffer;
  trailingBytes?: number | undefined;
  maxHits?: number | undefined;
}

/** A strictly read-only view of one process. Construct via {@link open}. */
export class ReadOnlyMemory {
  private constructor(private readonly backend: MemBackend) {}

  get pid(): number {
    return this.backend.pid;
  }
  get regions(): MemoryRegion[] {
    return this.backend.regions;
  }

  /** Open the target read-only via the platform backend. Throws if the process is
   *  gone or unreadable (uid/ptrace on Linux; privileges on Windows). */
  static async open(pid: number): Promise<ReadOnlyMemory> {
    const backend = process.platform === "win32" ? await openWindows(pid) : await openLinux(pid);
    return new ReadOnlyMemory(backend);
  }

  /** Read a slice of the target's address space. Read-only. */
  read(address: number, length: number): Promise<Buffer> {
    return this.backend.read(address, length);
  }

  /** Regions worth scanning for live session data: writable + anonymous/private.
   *  Session state (nonce, account id) lives in the heap, never in the gigabytes
   *  of read-only, file-backed mappings - this cuts the scan to ~tens of MB. */
  scanRegions(): MemoryRegion[] {
    return this.regions.filter(
      (r) => r.perms[1] === "w" && (r.path === null || r.path.startsWith("[")),
    );
  }

  /** Search for a byte pattern, capturing trailing bytes so a caller can pull an
   *  adjacent value. Scans only writable anonymous regions by default. */
  async scan(needle: Buffer, opts: ScanOptions = {}): Promise<ScanHit[]> {
    const [hits] = await this.scanMany([{ needle, trailingBytes: opts.trailingBytes, maxHits: opts.maxHits }], opts);
    return hits ?? [];
  }

  /** Search for several patterns in ONE pass over memory (hits per pattern, in
   *  order). Reading the game's memory is the slow part - on Windows it can be
   *  gigabytes - so every needle is matched against each chunk while it's in
   *  hand rather than re-reading everything once per needle. */
  async scanMany(
    patterns: ScanPattern[],
    opts: Pick<ScanOptions, "allRegions" | "onProgress"> = {},
  ): Promise<ScanHit[][]> {
    const pats = patterns.map((p) => ({ needle: p.needle, trailing: p.trailingBytes ?? 64, max: p.maxHits ?? 32 }));
    const hits: ScanHit[][] = pats.map(() => []);
    const done = () => pats.every((p, i) => hits[i]!.length >= p.max);
    // Read far enough past the chunk for a needle that starts in it to be
    // whole AND carry its full trailing context.
    const overlap = Math.max(0, ...pats.map((p) => p.needle.length + p.trailing));
    const regions = opts.allRegions ? this.regions : this.scanRegions();
    const total = regions.reduce((n, r) => n + (r.end - r.start), 0);
    const CHUNK = 1 << 20; // 1 MiB
    let scanned = 0;
    for (const region of regions) {
      for (let addr = region.start; addr < region.end; addr += CHUNK) {
        const size = Math.min(CHUNK, region.end - addr);
        // Never read past the region: on Windows the next page is often
        // uncommitted, and ReadProcessMemory then fails the WHOLE read, which
        // used to skip every small region. A hit in the region's last bytes
        // just gets whatever trailing context the region has.
        const readLen = Math.min(size + overlap, region.end - addr);
        let buf: Buffer;
        try {
          buf = await this.read(addr, readLen);
        } catch {
          break; // region became unreadable (process moved on); skip it
        }
        pats.forEach((p, i) => {
          const found = hits[i]!;
          let idx = found.length < p.max ? buf.indexOf(p.needle) : -1;
          while (idx !== -1 && idx < size) {
            const from = idx + p.needle.length;
            // Copy: `buf` is the whole chunk, and hits outlive it.
            found.push({ region, address: addr + idx, trailing: Buffer.from(buf.subarray(from, from + p.trailing)) });
            if (found.length >= p.max) break;
            idx = buf.indexOf(p.needle, idx + 1);
          }
        });
        if (done()) return hits;
        scanned += size;
        opts.onProgress?.(scanned, total);
        // Yield to the event loop between chunks. The Windows backend reads
        // synchronously, and the scan runs in the app's main process: without
        // this the window (and the local server) freeze for the whole scan.
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    return hits;
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}
