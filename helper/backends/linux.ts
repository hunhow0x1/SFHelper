import { open, readFile, type FileHandle } from "node:fs/promises";
import type { MemBackend, MemoryRegion } from "./types";

export function parseMaps(maps: string): MemoryRegion[] {
  const regions: MemoryRegion[] = [];
  for (const line of maps.split("\n")) {
    const match = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S{4})\s+\S+\s+\S+\s+\S+\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, startHex, endHex, perms, rest] = match;
    if (!startHex || !endHex || !perms) continue;
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

class LinuxBackend implements MemBackend {
  constructor(
    readonly pid: number,
    private readonly handle: FileHandle,
    readonly regions: MemoryRegion[],
  ) {}

  async read(address: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    await this.handle.read(buf, 0, length, address);
    return buf;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export async function openLinux(pid: number): Promise<MemBackend> {
  const maps = await readFile(`/proc/${pid}/maps`, "utf8");
  const handle = await open(`/proc/${pid}/mem`, "r");
  return new LinuxBackend(pid, handle, parseMaps(maps));
}
