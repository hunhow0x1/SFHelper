// Exploration helper: walk the Soulframe cache manifests and dump/inspect paths.
// Reuses the same SHCC/Oodle/manifest logic as extract_names.mjs.
//
// Usage:
//   node scripts/explore_cache.mjs manifest /H.Cache.bin        # list a manifest's paths
//   node scripts/explore_cache.mjs find <substr>                # search B.Cache.Windows.bin paths
//   node scripts/explore_cache.mjs dump <path>                  # download+decompress a path, hexdump/strings

import { decompress as oozDecompress } from "ooz-wasm";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TYPE_MANIFEST = 0xe;
const CONTENT_HOST = "http://content.soulframe.com";
const ORIGIN_HOST = "http://origin.soulframe.com";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const DATA_DIR = process.env.SFHELPER_CACHE_DIR ?? join(homedir(), ".cache", "sfhelper-cache");
const NO_HASH = "---------------------w";
const b64m = (buf) => buf.toString("base64").replace(/=+$/, "").replaceAll("/", "-");

function oodleBlocks(buf, i, decSize) {
  const out = [];
  let have = 0;
  while (have < decSize) {
    const info = buf.subarray(i, i + 8);
    i += 8;
    if (info[0] !== 0x80 || (info[7] & 0x0f) !== 0x01) throw new Error(`bad Oodle block ${info.toString("hex")}`);
    const blockComp = (info.readUInt32BE(0) >>> 2) & 0xffffff;
    const blockDec = (info.readUInt32BE(4) >>> 5) & 0xffffff;
    const chunk = buf.subarray(i, i + blockComp);
    i += blockComp;
    out.push(Buffer.from(oozDecompress(chunk, blockDec)));
    have += blockDec;
  }
  return [Buffer.concat(out).subarray(0, decSize), i];
}
function shccChunk(buf, i) {
  const chunkType = buf[i];
  const decSize = buf.readUInt32LE(i + 1);
  const compSize = buf.readUInt32LE(i + 5);
  i += 9;
  if (chunkType === 0) return [buf.subarray(i, i + compSize), i + decSize];
  if (chunkType !== 2) throw new Error(`unknown SHCC chunk type ${chunkType}`);
  return oodleBlocks(buf, i, decSize);
}
function shccUnpack(buf) {
  if (buf.subarray(0, 4).toString("latin1") !== "SHCC") buf = Buffer.from(oozDecompress(buf, buf.length * 10));
  return shccChunk(buf, 8)[0];
}
const manifestTypes = new Map(); // path -> 4 trailing bytes (LE int type id)
function parseManifest(h) {
  let i = 20;
  const hashes = new Map();
  while (i < h.length) {
    let remaining = 0;
    while (remaining === 0 && i < h.length) { remaining = h.readUInt32LE(i); i += 4; }
    for (let n = 0; n < remaining && i < h.length; n++) {
      const plen = h.readUInt32LE(i); i += 4;
      const path = h.subarray(i, i + plen).toString("latin1"); i += plen;
      hashes.set(path, h.subarray(i, i + 16));
      manifestTypes.set(path, h.readUInt32LE(i + 16));
      i += 20;
    }
  }
  return hashes;
}
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
  const h = shccUnpack(Buffer.from(await res.arrayBuffer()));
  await mkdir(dirname(local), { recursive: true });
  await writeFile(local, h);
  return h;
}

async function rootManifest() {
  return parseManifest(await downloadH("/H.Cache.bin", TYPE_MANIFEST));
}
// The big content manifest that lists every /SF/... path.
async function contentManifest() {
  const root = await rootManifest();
  const p = "/B.Cache.Windows.bin";
  const hash = root.get(p);
  if (!hash) throw new Error(`${p} not in root manifest; root has: ${[...root.keys()].join(", ")}`);
  return parseManifest(await downloadH(p, TYPE_MANIFEST, b64m(hash)));
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "manifest") {
  const m = arg === "/H.Cache.bin" ? await rootManifest() : await contentManifest();
  for (const k of [...m.keys()].sort()) console.log(k);
  console.error(`\n${m.size} paths`);
} else if (cmd === "find") {
  const m = await contentManifest();
  const hits = [...m.keys()].filter((k) => k.toLowerCase().includes(arg.toLowerCase())).sort();
  for (const k of hits) console.log(k);
  console.error(`\n${hits.length} / ${m.size} paths match "${arg}"`);
} else if (cmd === "dump") {
  const m = await contentManifest();
  const hash = m.get(arg);
  if (!hash) throw new Error(`${arg} not in content manifest`);
  const h = await downloadH(arg, 0x2c, b64m(hash));
  const outfile = join("/tmp", "cache_dump.bin");
  await writeFile(outfile, h);
  console.error(`decompressed ${h.length} bytes -> ${outfile}`);
  // print printable strings >=4 chars
  const s = h.toString("latin1");
  const strings = s.match(/[\x20-\x7e]{4,}/g) || [];
  for (const str of strings) console.log(str);
} else if (cmd === "probe-types") {
  const root = await rootManifest();
  console.log("B.Cache.Windows.bin (known URL type 0xE):", "0x" + manifestTypes.get("/B.Cache.Windows.bin").toString(16));
  const langHash = root.get("/B.Cache.Windows_en.bin");
  const lang = parseManifest(await downloadH("/B.Cache.Windows_en.bin", TYPE_MANIFEST, b64m(langHash)));
  console.log("Languages.bin (known URL type 0x2C):", "0x" + manifestTypes.get("/Languages.bin").toString(16));
} else if (cmd === "typeof") {
  const m = await contentManifest();
  const hash = m.get(arg);
  if (!hash) throw new Error(`${arg} not in content manifest`);
  console.log(`${arg}  type=0x${manifestTypes.get(arg).toString(16)} (${manifestTypes.get(arg)})  hash=${b64m(hash)}`);
} else if (cmd === "dumptype") {
  // dumptype <path> <typeIdHex>
  const path = arg;
  const typeHex = process.argv[4];
  const m = await contentManifest();
  const hash = m.get(path);
  if (!hash) throw new Error(`${path} not in content manifest`);
  const h = await downloadH(path, parseInt(typeHex, 16), b64m(hash));
  await writeFile("/tmp/cache_dump.bin", h);
  console.error(`decompressed ${h.length} bytes -> /tmp/cache_dump.bin`);
} else {
  console.error("commands: manifest </H.Cache.bin|content> | find <substr> | typeof <path> | dump <path> | dumptype <path> <typeHex>");
}
