// Parse a local Languages.bin (already decompressed from the cache entry) into
// { path+name: string }. Names are stored uncompressed; long descriptions are
// zstd-with-custom-dictionary. Node 26's zstd supports a raw dictionary, so we
// can decode descriptions too (unlike the CDN extractor, which skipped them).
//
// Usage: node scripts/extract_lang_local.mjs <Languages.bin> [--out dict.json] [--grep substr]

import { readFileSync, writeFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, grep: { type: "string" } },
});
const buf = readFileSync(positionals[0]);

let i = 16 + 4 + 4 + 4; // hash, 0x14, 0x2B/0x2C, 0x01
const numSuffixes = buf.readUInt32LE(i); i += 4;
for (let s = 0; s < numSuffixes; s++) { const slen = buf.readUInt32LE(i); i += 4 + slen; }
const dictLen = buf.readUInt32LE(i); i += 4;
const dictionary = buf.subarray(i, i + dictLen); i += dictLen;
const numPaths = buf.readUInt32LE(i); i += 4;

let decoded = 0, failed = 0;
const entries = {};
for (let p = 0; p < numPaths; p++) {
  const plen = buf.readUInt32LE(i); i += 4;
  const path = buf.subarray(i, i + plen).toString("latin1"); i += plen;
  const clen = buf.readUInt32LE(i); i += 4;
  const chunk = buf.subarray(i, i + clen); i += clen;
  const numLabels = buf.readUInt32LE(i); i += 4;
  for (let l = 0; l < numLabels; l++) {
    const nlen = buf.readUInt32LE(i); i += 4;
    const name = buf.subarray(i, i + nlen).toString("latin1"); i += nlen;
    const offset = buf.readUInt32LE(i);
    const size = buf.readUInt16LE(i + 4);
    const flags = buf.readUInt16LE(i + 6);
    i += 8;
    let data = chunk.subarray(offset, offset + size);
    if (flags & 0x200) {
      try { data = zstdDecompressSync(data, { dictionary }); decoded++; }
      catch { failed++; continue; }
    }
    entries[path + name] = data.toString("utf8");
  }
}

console.error(`paths=${numPaths} entries=${Object.keys(entries).length} zstd-decoded=${decoded} zstd-failed=${failed} dictLen=${dictLen}`);
if (values.grep) {
  const g = values.grep.toLowerCase();
  for (const [k, v] of Object.entries(entries)) if (k.toLowerCase().includes(g)) console.log(k + "  =>  " + v.slice(0, 160));
}
if (values.out) { writeFileSync(values.out, JSON.stringify(entries, Object.keys(entries).sort(), 2)); console.error(`wrote ${values.out}`); }
