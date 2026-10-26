// Extract Soulframe's in-game name dictionary - no proprietary Oodle DLL.
//
// Oodle decompression is done with `ooz-wasm`, an open-source clean-room Kraken
// decompressor shipped as WebAssembly. It is a normal dependency (installed by
// the app's `npm install`), so there is no separate library to fetch and
// nothing proprietary in the tree.
//
// Flow (ported from Sainan's warframe-cache-tools, targeted at Soulframe):
//   H.Cache.bin -> B.Cache.Windows_<lang>.bin -> Languages.bin (suffix _<lang>)
// Each file is an SHCC container whose chunks are Oodle (format 0x8c = Kraken).
// The final Languages.bin H-chunk parses into { "<path><name>": "<string>" }.
//
// Usage:  node scripts/extract_names.mjs [--lang en] [--out dict.en.json]
//
// Long, flagged strings (descriptions) are zstd frames compressed against a
// dictionary stored in Languages.bin; Node's built-in zstd decodes them (on
// Node versions without zstd they're skipped with a note). Item/faction NAMES
// are short and stored uncompressed, so names work either way.

import { decompress as oozDecompress } from "ooz-wasm";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import * as zlib from "node:zlib";

const TYPE_MANIFEST = 0xe;
const TYPE_BIN = 0x2c;
const CONTENT_HOST = "http://content.soulframe.com";
const ORIGIN_HOST = "http://origin.soulframe.com";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const DATA_DIR = process.env.SFHELPER_CACHE_DIR ?? join(homedir(), ".cache", "sfhelper-cache");
const NO_HASH = "---------------------w";

const b64m = (buf) => buf.toString("base64").replace(/=+$/, "").replaceAll("/", "-");

// --- Oodle blocks (shcc_decompress_chunk_oodle) --------------------------------
function oodleBlocks(buf, i, decSize) {
  const out = [];
  let have = 0;
  while (have < decSize) {
    const info = buf.subarray(i, i + 8);
    i += 8;
    if (info[0] !== 0x80 || (info[7] & 0x0f) !== 0x01) {
      throw new Error(`bad Oodle block header ${info.toString("hex")}`);
    }
    const num1 = info.readUInt32BE(0);
    const num2 = info.readUInt32BE(4);
    const blockComp = (num1 >>> 2) & 0xffffff;
    const blockDec = (num2 >>> 5) & 0xffffff;
    const chunk = buf.subarray(i, i + blockComp);
    i += blockComp;
    out.push(Buffer.from(oozDecompress(chunk, blockDec)));
    have += blockDec;
  }
  return [Buffer.concat(out).subarray(0, decSize), i];
}

// --- SHCC container ------------------------------------------------------------
function shccChunk(buf, i) {
  const chunkType = buf[i];
  const decSize = buf.readUInt32LE(i + 1);
  const compSize = buf.readUInt32LE(i + 5);
  i += 9;
  if (chunkType === 0) {
    return [buf.subarray(i, i + compSize), i + decSize];
  }
  if (chunkType !== 2) throw new Error(`unknown SHCC chunk type ${chunkType}`);
  return oodleBlocks(buf, i, decSize);
}

function shccUnpack(buf) {
  if (buf.subarray(0, 4).toString("latin1") !== "SHCC") {
    buf = Buffer.from(oozDecompress(buf, buf.length * 10));
  }
  const [h] = shccChunk(buf, 8);
  return h;
}

// --- Manifest (path -> content hash) ------------------------------------------
function parseManifest(h) {
  let i = 20;
  const hashes = new Map();
  while (i < h.length) {
    let remaining = 0;
    while (remaining === 0 && i < h.length) {
      remaining = h.readUInt32LE(i);
      i += 4;
    }
    for (let n = 0; n < remaining && i < h.length; n++) {
      const plen = h.readUInt32LE(i);
      i += 4;
      const path = h.subarray(i, i + plen).toString("latin1");
      i += plen;
      hashes.set(path, h.subarray(i, i + 16));
      i += 20; // 16 hash + 4 unk
    }
  }
  return hashes;
}

// --- Download + cache ----------------------------------------------------------
async function downloadH(path, typeId, hash = NO_HASH, suffix = "") {
  const local = join(DATA_DIR, `0${suffix}${path}_H`);
  if (existsSync(local)) return readFile(local);

  const reqPath = `/0${suffix}${path}!${typeId.toString(16).toUpperCase()}_${hash}`;
  const url =
    reqPath === "/0/H.Cache.bin!E_---------------------w"
      ? `${ORIGIN_HOST}/origin/${((Math.random() * 0xffffffff) >>> 0).toString(16).padStart(8, "0").toUpperCase()}${reqPath}`
      : CONTENT_HOST + reqPath;
  console.error(`Downloading ${url}`);
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${path}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const h = shccUnpack(raw);
  await mkdir(dirname(local), { recursive: true });
  await writeFile(local, h);
  return h;
}

// --- Languages.bin (languages_unpack) -----------------------------------------
function u32DynLe(buf, i) {
  let value = 0;
  let shift = 0;
  while (shift < 28) {
    const byte = buf[i++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value >>> 0, i];
    shift += 7;
  }
  return [(value | (buf[i] << shift)) >>> 0, i + 1];
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// A flagged entry is its decompressed size (LEB128), then a zstd frame with the
// magic number stripped. Null if this Node can't decode it.
function zstdDictDecompress(data, dictionary) {
  if (typeof zlib.zstdDecompressSync !== "function") return null;
  const [, start] = u32DynLe(data, 0);
  try {
    return zlib.zstdDecompressSync(Buffer.concat([ZSTD_MAGIC, data.subarray(start)]), { dictionary });
  } catch {
    return null;
  }
}

function languagesUnpack(buf) {
  let i = 16 + 4 + 4 + 4; // hash, 0x14, 0x2B, 0x01
  const numSuffixes = buf.readUInt32LE(i);
  i += 4;
  for (let s = 0; s < numSuffixes; s++) {
    const slen = buf.readUInt32LE(i);
    i += 4 + slen;
  }
  const dictLen = buf.readUInt32LE(i);
  const dictionary = buf.subarray(i + 4, i + 4 + dictLen); // used only by flagged entries
  i += 4 + dictLen;
  const numPaths = buf.readUInt32LE(i);
  i += 4;

  const entries = {};
  let skippedCompressed = 0;
  for (let p = 0; p < numPaths; p++) {
    const plen = buf.readUInt32LE(i);
    i += 4;
    const path = buf.subarray(i, i + plen).toString("latin1");
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
      const name = buf.subarray(i, i + nlen).toString("latin1");
      i += nlen;
      const offset = buf.readUInt32LE(i);
      const size = buf.readUInt16LE(i + 4);
      const flags = buf.readUInt16LE(i + 6);
      i += 8;
      let data = chunk.subarray(offset, offset + size);
      if (flags & 0x200) {
        const decoded = zstdDictDecompress(data, dictionary);
        if (decoded === null) {
          skippedCompressed++;
          continue;
        }
        data = decoded;
      }
      entries[path + name] = data.toString("utf8");
    }
  }
  if (skippedCompressed) {
    console.error(`(skipped ${skippedCompressed} dictionary-compressed entries - long text, not names; needs Node with zstd)`);
  }
  return entries;
}

// --- main ----------------------------------------------------------------------
const { values } = parseArgs({
  options: { lang: { type: "string", default: "en" }, out: { type: "string", default: "dict.en.json" } },
});
const suffix = `_${values.lang}`;

const rootManifest = parseManifest(await downloadH("/H.Cache.bin", TYPE_MANIFEST));
const langBinPath = `/B.Cache.Windows${suffix}.bin`;
const langHash = rootManifest.get(langBinPath);
if (!langHash) throw new Error(`${langBinPath} not in root manifest`);

const langManifest = parseManifest(await downloadH(langBinPath, TYPE_MANIFEST, b64m(langHash)));
const languagesHash = langManifest.get("/Languages.bin");
if (!languagesHash) throw new Error("/Languages.bin not in language manifest");

const languagesH = await downloadH("/Languages.bin", TYPE_BIN, b64m(languagesHash), suffix);
const entries = languagesUnpack(languagesH);
await writeFile(values.out, JSON.stringify(entries, Object.keys(entries).sort(), 2));
console.error(`Wrote ${Object.keys(entries).length} entries to ${values.out}`);
