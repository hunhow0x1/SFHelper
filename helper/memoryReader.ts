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
  allRegions?: boolean;
  onProgress?: ((scanned: number, total: number) => void) | undefined;
}

export interface ScanPattern {
  needle: Buffer;
  trailingBytes?: number | undefined;
  maxHits?: number | undefined;
}

export class ReadOnlyMemory {
  private constructor(private readonly backend: MemBackend) {}

  get pid(): number {
    return this.backend.pid;
  }
  get regions(): MemoryRegion[] {
    return this.backend.regions;
  }

  static async open(pid: number): Promise<ReadOnlyMemory> {
    const backend = process.platform === "win32" ? await openWindows(pid) : await openLinux(pid);
    return new ReadOnlyMemory(backend);
  }

  read(address: number, length: number): Promise<Buffer> {
    return this.backend.read(address, length);
  }

  scanRegions(): MemoryRegion[] {
    return this.regions.filter(
      (r) => r.perms[1] === "w" && (r.path === null || r.path.startsWith("[")),
    );
  }

  async scan(needle: Buffer, opts: ScanOptions = {}): Promise<ScanHit[]> {
    const [hits] = await this.scanMany([{ needle, trailingBytes: opts.trailingBytes, maxHits: opts.maxHits }], opts);
    return hits ?? [];
  }

  async scanMany(
    patterns: ScanPattern[],
    opts: Pick<ScanOptions, "allRegions" | "onProgress"> = {},
  ): Promise<ScanHit[][]> {
    const pats = patterns.map((p) => ({ needle: p.needle, trailing: p.trailingBytes ?? 64, max: p.maxHits ?? 32 }));
    const hits: ScanHit[][] = pats.map(() => []);
    const done = () => pats.every((p, i) => hits[i]!.length >= p.max);
    const overlap = Math.max(0, ...pats.map((p) => p.needle.length + p.trailing));
    const regions = opts.allRegions ? this.regions : this.scanRegions();
    const total = regions.reduce((n, r) => n + (r.end - r.start), 0);
    const CHUNK = 1 << 20;
    let scanned = 0;
    for (const region of regions) {
      for (let addr = region.start; addr < region.end; addr += CHUNK) {
        const size = Math.min(CHUNK, region.end - addr);
        const readLen = Math.min(size + overlap, region.end - addr);
        let buf: Buffer;
        try {
          buf = await this.read(addr, readLen);
        } catch {
          break;
        }
        pats.forEach((p, i) => {
          const found = hits[i]!;
          let idx = found.length < p.max ? buf.indexOf(p.needle) : -1;
          while (idx !== -1 && idx < size) {
            const from = idx + p.needle.length;
            found.push({ region, address: addr + idx, trailing: Buffer.from(buf.subarray(from, from + p.trailing)) });
            if (found.length >= p.max) break;
            idx = buf.indexOf(p.needle, idx + 1);
          }
        });
        if (done()) return hits;
        scanned += size;
        opts.onProgress?.(scanned, total);
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    return hits;
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}
