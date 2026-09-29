// Read the LOCAL installed Soulframe cache (Cache.Windows/*.toc + *.cache).
// No CDN, no proprietary Oodle DLL - decompresses with ooz-wasm, same block
// codec as the CDN path (extract_names.mjs).
//
// TOC: uint32 magic 0x1867C64E, uint32 version, then 96-byte entries:
//   int64 offset(-1=dir), int64 timestamp, int32 compSize, int32 decompSize,
//   int32 flags, int32 compType, char[64] name (leaf, NUL-padded).
//
// Usage:
//   node scripts/local_cache.mjs search <name.toc> <name.cache> <text> [--names]
//   node scripts/local_cache.mjs extract <name.toc> <name.cache> <nameSubstr> <outdir>

import { decompress as oozDecompress } from "ooz-wasm";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import lzma from "node:zlib";

const MAGIC = 0x1867c64e;
const ENTRY = 96;

function unwrap(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === MAGIC) return buf;
  // On-disk files are raw; CDN ones are whole-file LZMA. Try LZMA-alone.
  try { return Buffer.from(lzma.default ? [] : []); } catch { return buf; }
}

function parseToc(buf) {
  buf = unwrap(buf);
  const magic = buf.readUInt32LE(0);
  if (magic !== MAGIC) throw new Error(`not a DE TOC (magic 0x${magic.toString(16)})`);
  const body = buf.subarray(8);
  const entries = [];
  const n = Math.floor(body.length / ENTRY);
  for (let i = 0; i < n; i++) {
    const e = body.subarray(i * ENTRY, (i + 1) * ENTRY);
    const offset = Number(e.readBigInt64LE(0));
    const compSize = e.readInt32LE(16);
    const decSize = e.readInt32LE(20);
    const compType = e.readInt32LE(28);
    const name = e.subarray(32, 96).toString("latin1").split("\0")[0];
    entries.push({ index: i, offset, compSize, decSize, compType, name, isDir: offset < 0, isRaw: compSize === decSize });
  }
  return entries;
}

function oodleBlocks(buf, i, decSize) {
  const out = [];
  let have = 0;
  while (have < decSize) {
    const info = buf.subarray(i, i + 8);
    i += 8;
    if (info[0] !== 0x80 || (info[7] & 0x0f) !== 0x01) throw new Error(`bad block ${info.toString("hex")}`);
    const blockComp = (info.readUInt32BE(0) >>> 2) & 0xffffff;
    const blockDec = (info.readUInt32BE(4) >>> 5) & 0xffffff;
    out.push(Buffer.from(oozDecompress(buf.subarray(i, i + blockComp), blockDec)));
    i += blockComp;
    have += blockDec;
  }
  return Buffer.concat(out).subarray(0, decSize);
}

function readEntry(cache, e) {
  const blob = cache.subarray(e.offset, e.offset + e.compSize);
  if (e.isRaw) return Buffer.from(blob);
  return oodleBlocks(blob, 0, e.decSize);
}

const [cmd, tocPath, cachePath, arg, outdir] = process.argv.slice(2);

if (cmd === "search") {
  const entries = parseToc(readFileSync(tocPath));
  const cache = readFileSync(cachePath);
  const byName = process.argv.includes("--names");
  const target = Buffer.from(arg, "utf8");
  let hits = 0, skipped = 0;
  for (const e of entries) {
    if (e.isDir) continue;
    if (byName) {
      if (e.name.toLowerCase().includes(arg.toLowerCase())) { console.log(`  [${e.index}] ${e.name}  ${e.compSize}->${e.decSize} ${e.isRaw ? "raw" : "c" + e.compType}`); hits++; }
      continue;
    }
    let data;
    try { data = readEntry(cache, e); } catch { skipped++; continue; }
    const idx = data.indexOf(target);
    if (idx >= 0) { hits++; console.log(`  HIT [${e.index}] ${e.name}: ...${data.subarray(Math.max(0, idx - 30), idx + 70).toString("latin1")}...`); }
  }
  console.error(`\n${hits} hits; ${skipped} entries failed to decompress`);
} else if (cmd === "extract") {
  const entries = parseToc(readFileSync(tocPath));
  const cache = readFileSync(cachePath);
  mkdirSync(outdir, { recursive: true });
  let n = 0, skipped = 0;
  for (const e of entries) {
    if (e.isDir || !e.name.toLowerCase().includes(arg.toLowerCase())) continue;
    let data;
    try { data = readEntry(cache, e); } catch { skipped++; continue; }
    writeFileSync(join(outdir, `${e.index}_${e.name}`), data);
    n++;
  }
  console.error(`extracted ${n} file(s) to ${outdir}; ${skipped} failed`);
} else if (cmd === "codectypes") {
  const entries = parseToc(readFileSync(tocPath));
  const cache = readFileSync(cachePath);
  const byType = new Map();
  for (const e of entries) {
    if (e.isDir) continue;
    let ok = e.isRaw;
    if (!ok) { try { readEntry(cache, e); ok = true; } catch { ok = false; } }
    const key = e.isRaw ? "raw" : `c${e.compType}`;
    const rec = byType.get(key) || { ok: 0, fail: 0, ex: [] };
    if (ok) rec.ok++; else { rec.fail++; if (rec.ex.length < 4) rec.ex.push(`${e.name}(${e.compSize}->${e.decSize},b0=0x${(cache[e.offset] || 0).toString(16)})`); }
    byType.set(key, rec);
  }
  for (const [k, r] of byType) console.log(`${k}: ok=${r.ok} fail=${r.fail}${r.fail ? "  e.g. " + r.ex.join(", ") : ""}`);
} else {
  console.error("commands: search <toc> <cache> <text> [--names] | extract <toc> <cache> <nameSubstr> <outdir> | codectypes <toc> <cache>");
}
