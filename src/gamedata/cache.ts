import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { oodleBlocks } from "./codecs";

const TOC_MAGIC = 0x1867c64e;
const TOC_HEADER = 8;
const TOC_ENTRY = 96;
const NAME_AT = 32;

export interface TocEntry {
  name: string;
  offset: number;
  stamp: string;
  compSize: number;
  decSize: number;
}

export interface CacheFile {
  toc: string;
  cache: string;
  name: string;
}

export const PACKAGES: CacheFile = { toc: "H.Misc.toc", cache: "H.Misc.cache", name: "Packages.bin" };
export const LANGUAGES: CacheFile = { toc: "H.Misc_en.toc", cache: "H.Misc_en.cache", name: "Languages.bin" };
const FILES = [PACKAGES, LANGUAGES];

export function findRootEntry(toc: Buffer, name: string): TocEntry | null {
  if (toc.length < TOC_HEADER || toc.readUInt32LE(0) !== TOC_MAGIC) throw new Error("not a Soulframe cache index");
  const want = Buffer.from(`${name}\0`, "latin1");
  let best: { at: number; stamp: bigint } | null = null;
  for (let at = TOC_HEADER; at + TOC_ENTRY <= toc.length; at += TOC_ENTRY) {
    if (toc.readInt32LE(at + 28) !== 0 || toc.compare(want, 0, want.length, at + NAME_AT, at + NAME_AT + want.length) !== 0) continue;
    if (toc.readBigInt64LE(at) < 0n) continue;
    const stamp = toc.readBigInt64LE(at + 8);
    if (!best || stamp >= best.stamp) best = { at, stamp };
  }
  if (!best) return null;
  return {
    name,
    offset: Number(toc.readBigInt64LE(best.at)),
    stamp: best.stamp.toString(),
    compSize: toc.readInt32LE(best.at + 16),
    decSize: toc.readInt32LE(best.at + 20),
  };
}

export function tocIndex(toc: Buffer): Map<string, TocEntry> {
  if (toc.length < TOC_HEADER || toc.readUInt32LE(0) !== TOC_MAGIC) throw new Error("not a Soulframe cache index");
  const count = Math.floor((toc.length - TOC_HEADER) / TOC_ENTRY);
  const names: string[] = [];
  const parents: number[] = [];
  const dirs: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = TOC_HEADER + i * TOC_ENTRY;
    names.push(toc.toString("latin1", at + NAME_AT, at + TOC_ENTRY).split("\0")[0]!);
    parents.push(toc.readInt32LE(at + 28));
    if (toc.readBigInt64LE(at) < 0n) dirs.push(i);
  }
  const dirPaths = new Map<number, string>();
  const pathOf = (i: number): string => {
    const parts = [names[i]!];
    let p = parents[i]!;
    while (p > 0 && parts.length < 64) {
      const d = dirs[p - 1];
      if (d === undefined) break;
      const known = dirPaths.get(d);
      if (known !== undefined) return `${known}/${parts.reverse().join("/")}`;
      parts.push(names[d]!);
      p = parents[d]!;
    }
    return `/${parts.reverse().join("/")}`;
  };
  for (const d of dirs) dirPaths.set(d, pathOf(d));
  const out = new Map<string, TocEntry>();
  for (let i = 0; i < count; i++) {
    const at = TOC_HEADER + i * TOC_ENTRY;
    if (toc.readBigInt64LE(at) < 0n) continue;
    const path = pathOf(i);
    const stamp = toc.readBigInt64LE(at + 8);
    const prev = out.get(path);
    if (prev && BigInt(prev.stamp) > stamp) continue;
    out.set(path, {
      name: path,
      offset: Number(toc.readBigInt64LE(at)),
      stamp: stamp.toString(),
      compSize: toc.readInt32LE(at + 16),
      decSize: toc.readInt32LE(at + 20),
    });
  }
  return out;
}

export async function readEntry(cachePath: string, e: TocEntry): Promise<Buffer> {
  const fh = await open(cachePath, "r");
  try {
    const blob = Buffer.alloc(e.compSize);
    const { bytesRead } = await fh.read(blob, 0, e.compSize, e.offset);
    if (bytesRead !== e.compSize) throw new Error(`${e.name}: cache file ends early`);
    return e.compSize === e.decSize ? blob : await oodleBlocks(blob, e.decSize);
  } finally {
    await fh.close();
  }
}

export async function cacheStamp(dir: string): Promise<{ id: string; changedAt: number } | null> {
  const parts: string[] = [];
  let changedAt = 0;
  for (const f of FILES) {
    try {
      const s = await stat(join(dir, f.toc));
      parts.push(`${f.toc}:${s.size}:${Math.round(s.mtimeMs)}`);
      changedAt = Math.max(changedAt, s.mtimeMs);
    } catch {
      return null;
    }
  }
  return { id: parts.join("|"), changedAt };
}

export interface GameFiles {
  packages: Buffer;
  languages: Buffer;
  hash: string;
}

async function readCacheFile(dir: string, f: CacheFile): Promise<Buffer> {
  const e = findRootEntry(await readFile(join(dir, f.toc)), f.name);
  if (!e) throw new Error(`${f.name} is not in ${f.toc}`);
  return readEntry(join(dir, f.cache), e);
}

export async function readGameFiles(dir: string): Promise<GameFiles> {
  const packages = await readCacheFile(dir, PACKAGES);
  const languages = await readCacheFile(dir, LANGUAGES);
  const hash = createHash("sha256").update(packages).update(languages).digest("hex");
  return { packages, languages, hash };
}

export function hostPath(winPath: string, logPath: string, platform: string = process.platform): string | null {
  const clean = winPath.trim().replace(/[\\/]+$/, "");
  if (platform === "win32") return clean;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(clean);
  const at = logPath.indexOf("/drive_c/");
  if (!m || at < 0) return null;
  const prefix = logPath.slice(0, at);
  const drive = m[1]!.toLowerCase();
  const rest = m[2]!.split(/[\\/]+/).join("/");
  return drive === "c" ? `${prefix}/drive_c/${rest}` : `${prefix}/dosdevices/${drive}:/${rest}`;
}

export async function findCacheDir(logPath: string | null, loggedDir: string | null, platform: string = process.platform): Promise<string | null> {
  const candidates: string[] = [];
  if (logPath && loggedDir) {
    const p = hostPath(loggedDir, logPath, platform);
    if (p) candidates.push(p);
  }
  if (logPath) candidates.push(join(dirname(logPath), "Downloaded", "Public", "Cache.Windows"));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Soulframe", "Downloaded", "Public", "Cache.Windows"));
  for (const dir of candidates) {
    try {
      await stat(join(dir, PACKAGES.toc));
      return dir;
    } catch {
    }
  }
  return null;
}
