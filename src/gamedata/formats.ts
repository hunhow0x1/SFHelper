// Readers for the game's packed data files, read-only.

import { breathe, uleb, ZstdDict } from "./codecs";

const DICT_MAGIC = Buffer.from([0x37, 0xa4, 0x30, 0xec]);
const YIELD_EVERY = 500;

export type Dict = Record<string, string>;
export type TypeTree = Map<string, string | null>;

// Languages.bin: for each text folder, a chunk of strings and a label table
// (name, offset, size, flags). Flag 0x200 marks entries compressed with zstd
// using a dictionary stored right after the file's header.
export async function readLanguages(buf: Buffer): Promise<Dict> {
  let i = 16 + 4 + 4 + 4;
  const numSuffixes = buf.readUInt32LE(i);
  i += 4;
  for (let s = 0; s < numSuffixes; s++) i += 4 + buf.readUInt32LE(i);
  const dictLen = buf.readUInt32LE(i);
  const zstd = await ZstdDict.load(buf.subarray(i + 4, i + 4 + dictLen));
  i += 4 + dictLen;
  const entries: Dict = {};
  try {
    const numPaths = buf.readUInt32LE(i);
    i += 4;
    for (let p = 0; p < numPaths; p++) {
      const plen = buf.readUInt32LE(i);
      i += 4;
      const path = buf.toString("latin1", i, i + plen);
      i += plen;
      const clen = buf.readUInt32LE(i);
      i += 4;
      const chunk = buf.subarray(i, i + clen);
      i += clen;
      const numLabels = buf.readUInt32LE(i);
      i += 4;
      for (let l = 0; l < numLabels; l++) {
        const nlen = buf.readUInt32LE(i);
        i += 4;
        const name = buf.toString("latin1", i, i + nlen);
        i += nlen;
        const offset = buf.readUInt32LE(i);
        const size = buf.readUInt16LE(i + 4);
        const flags = buf.readUInt16LE(i + 6);
        i += 8;
        let data: Buffer | null = chunk.subarray(offset, offset + size);
        if (flags & 0x200) {
          const [decLen, start] = uleb(data, 0);
          data = zstd.decompress(data.subarray(start), decLen);
          if (!data) continue;
        }
        entries[path + name] = data.toString("utf8");
      }
      await breathe();
    }
  } finally {
    zstd.free();
  }
  const sorted: Dict = {};
  for (const k of Object.keys(entries).sort()) sorted[k] = entries[k]!;
  return sorted;
}

// Packages.bin: zstd frames, one property-text record per type, in the same
// order as the type table after them. Not every type has a record, and the
// record doesn't name its type. The frame sizes are a ULEB list, found by
// checking which candidate list adds up to the compressed length.
export async function readPackageTexts(buf: Buffer): Promise<string[]> {
  const dictAt = buf.indexOf(DICT_MAGIC);
  if (dictAt < 4) throw new Error("Packages.bin: no zstd dictionary found");
  const zLen = buf.readUInt32LE(dictAt - 4);

  let sizes: { start: number; end: number; dictSize: number } | null = null;
  for (let p = 16; p < dictAt - 8 && !sizes; p++) {
    const len = buf.readUInt32LE(p);
    const dictSize = buf.readUInt32LE(p + 4);
    if (len < 8 || p + 4 + len > dictAt || dictSize < 65536 || dictSize > zLen) continue;
    let i = p + 8;
    let sum = 0;
    while (i < p + 4 + len) {
      let v: number;
      [v, i] = uleb(buf, i);
      sum += v;
    }
    if (sum === zLen - dictSize) sizes = { start: p + 8, end: p + 4 + len, dictSize };
  }
  if (!sizes) throw new Error("Packages.bin: frame sizes not found");

  const zstd = await ZstdDict.load(buf.subarray(dictAt, dictAt + sizes.dictSize));
  const texts: string[] = [];
  try {
    let z = dictAt + sizes.dictSize;
    for (let s = sizes.start; s < sizes.end; ) {
      let size: number;
      [size, s] = uleb(buf, s);
      const frame = buf.subarray(z, z + size);
      z += size;
      const [decLen, start] = uleb(frame, 0);
      const out = zstd.decompress(frame.subarray(start), decLen);
      const text = out && out.length === decLen ? out.toString("latin1") : frame.toString("latin1");
      texts.push(text.replace(/\x00$/, ""));
      if (texts.length % YIELD_EVERY === 0) await breathe();
    }
  } finally {
    zstd.free();
  }
  return texts;
}

// The type table: directory strings, each followed by (leaf, 3 flag bytes,
// parent) records. Scanning for directory strings finds every block.
export async function readTypeTree(buf: Buffer): Promise<TypeTree> {
  const parentOf: TypeTree = new Map();
  const text = buf.toString("latin1");
  const DIR_RE = /\/(?:SF|EE|Lotus)\/[A-Za-z0-9_/]*\/\x01/g;
  let seen = 0;
  for (let m; (m = DIR_RE.exec(text)); ) {
    if (++seen % YIELD_EVERY === 0) await breathe();
    const start = m.index;
    const dir = m[0].slice(0, -1);
    if (start < 4 || buf.readUInt32LE(start - 4) !== dir.length) continue;
    let i = start + dir.length + 1;
    const count = buf.readUInt32LE(i);
    i += 4;
    if (count > 100_000) continue;
    const found: [string, string | null][] = [];
    try {
      for (let n = 0; n < count; n += 1) {
        const nl = buf.readUInt32LE(i);
        const leaf = buf.toString("latin1", i + 4, i + 4 + nl);
        i += 4 + nl + 3;
        const pl = buf.readUInt32LE(i);
        const parent = buf.toString("latin1", i + 4, i + 4 + pl);
        i += 4 + pl;
        if (!/^[\w.-]+$/.test(leaf)) throw new Error("not a record");
        found.push([dir + leaf, parent.startsWith("/") ? parent : parent ? dir + parent : null]);
      }
    } catch {
      continue;
    }
    for (const [path, parent] of found) parentOf.set(path, parent);
  }
  return parentOf;
}
