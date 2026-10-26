// Every type's property text from Packages.bin (its header part, as cached by
// extract_names / explore_cache under ~/.cache/sfhelper-cache, or extracted
// from the game's local cache).
//
// The texts are stored as zstd frames that share one dictionary:
//   - the dictionary starts at its magic (37 a4 30 ec); the u32 just before
//     it is the size of the whole compressed area (dictionary + frames);
//   - a sizes buffer earlier in the file: u32 length, u32 dictionary size,
//     then one ULEB128 size per frame. It's found by checking that the sizes
//     add up exactly to the compressed area minus the dictionary;
//   - each frame is a ULEB128 decoded length, then a zstd frame without its
//     magic. Frames that don't decode are stored raw.
// Which type each frame belongs to isn't decoded here; callers find the text
// they want by its content.

import * as zlib from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DICT_MAGIC = Buffer.from([0x37, 0xa4, 0x30, 0xec]);

function uleb(buf, i) {
  let v = 0;
  let shift = 0;
  let c;
  do {
    c = buf[i++];
    v |= (c & 0x7f) << shift;
    shift += 7;
  } while (c & 0x80);
  return [v >>> 0, i];
}

/** All property texts in a Packages.bin buffer, in file order. */
export function readPackageTexts(buf) {
  const dictAt = buf.indexOf(DICT_MAGIC);
  if (dictAt < 4) throw new Error("Packages.bin: no zstd dictionary found");
  const zLen = buf.readUInt32LE(dictAt - 4);

  let sizes = null;
  for (let p = 16; p < dictAt - 8 && !sizes; p++) {
    const len = buf.readUInt32LE(p);
    const dictSize = buf.readUInt32LE(p + 4);
    if (len < 8 || p + 4 + len > dictAt || dictSize < 65536 || dictSize > zLen) continue;
    let i = p + 8;
    let sum = 0;
    while (i < p + 4 + len) {
      let v;
      [v, i] = uleb(buf, i);
      sum += v;
    }
    if (sum === zLen - dictSize) sizes = { start: p + 8, end: p + 4 + len, dictSize };
  }
  if (!sizes) throw new Error("Packages.bin: frame sizes not found");

  const dictionary = buf.subarray(dictAt, dictAt + sizes.dictSize);
  const texts = [];
  let z = dictAt + sizes.dictSize;
  for (let s = sizes.start; s < sizes.end; ) {
    let size;
    [size, s] = uleb(buf, s);
    const frame = buf.subarray(z, z + size);
    z += size;
    const [decLen, start] = uleb(frame, 0);
    let text = null;
    try {
      const out = zlib.zstdDecompressSync(Buffer.concat([ZSTD_MAGIC, frame.subarray(start)]), { dictionary });
      if (out.length === decLen) text = out.toString("latin1");
    } catch {
      // stored raw
    }
    texts.push((text ?? frame.toString("latin1")).replace(/\x00$/, ""));
  }
  return texts;
}
