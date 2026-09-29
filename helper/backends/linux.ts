/** Linux read-only memory backend: /proc/<pid>/mem + /proc/<pid>/maps.
 *
 *  Opens the mem file with the "r" flag only. There is no writable handle and no
 *  write path; this cannot modify the target even if misused.
 */

import { open, readFile, type FileHandle } from "node:fs/promises";
import type { MemBackend, MemoryRegion } from "./types";

/** Parse /proc/<pid>/maps into readable regions. */
export function parseMaps(maps: string): MemoryRegion[] {
  const regions: MemoryRegion[] = [];
  for (const line of maps.split("\n")) {
    const match = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S{4})\s+\S+\s+\S+\s+\S+\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, startHex, endHex, perms, rest] = match;
    if (!startHex || !endHex || !perms) continue;
    if (perms[0] !== "r") continue; // only regions the process can read
    regions.push({
      start: Number.parseInt(startHex, 16),
      end: Number.parseInt(endHex, 16),
      perms,
      path: rest && rest.trim() !== "" ? rest.trim() : null,
    });
  }
  return regions;
}

class LinuxBackend implements MemBackend {
  constructor(
    readonly pid: number,
    private readonly handle: FileHandle,
    readonly regions: MemoryRegion[],
  ) {}

  async read(address: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    await this.handle.read(buf, 0, length, address); // pread-style; no seek, no write
    return buf;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export async function openLinux(pid: number): Promise<MemBackend> {
  const maps = await readFile(`/proc/${pid}/maps`, "utf8");
  const handle = await open(`/proc/${pid}/mem`, "r"); // "r" — read-only
  return new LinuxBackend(pid, handle, parseMaps(maps));
}
