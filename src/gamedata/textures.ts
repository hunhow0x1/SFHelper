import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { readEntry, tocIndex, type TocEntry } from "./cache";

const TEXTURES = { toc: "B.Texture.toc", cache: "B.Texture.cache" };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const expand = (v: number, bits: number): number => Math.round((v * 255) / ((1 << bits) - 1));

function colors(src: Uint8Array, o: number, fourColour: boolean): number[][] {
  const c0 = src[o]! | (src[o + 1]! << 8);
  const c1 = src[o + 2]! | (src[o + 3]! << 8);
  const p0 = [expand(c0 >> 11, 5), expand((c0 >> 5) & 63, 6), expand(c0 & 31, 5), 255];
  const p1 = [expand(c1 >> 11, 5), expand((c1 >> 5) & 63, 6), expand(c1 & 31, 5), 255];
  if (fourColour || c0 > c1) {
    return [p0, p1, p0.map((v, i) => (i === 3 ? 255 : Math.round((2 * v + p1[i]!) / 3))), p0.map((v, i) => (i === 3 ? 255 : Math.round((v + 2 * p1[i]!) / 3)))];
  }
  return [p0, p1, p0.map((v, i) => (i === 3 ? 255 : Math.round((v + p1[i]!) / 2))), [0, 0, 0, 0]];
}

function decodeBlocks(src: Uint8Array, w: number, h: number, blockBytes: 8 | 16): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const bw = Math.max(1, Math.ceil(w / 4));
  const bh = Math.max(1, Math.ceil(h / 4));
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * blockBytes;
      let alpha: number[] | null = null;
      let alphaBits = 0n;
      if (blockBytes === 16) {
        const a0 = src[o]!;
        const a1 = src[o + 1]!;
        alpha = a0 > a1
          ? [a0, a1, ...[1, 2, 3, 4, 5, 6].map((i) => Math.round(((7 - i) * a0 + i * a1) / 7))]
          : [a0, a1, ...[1, 2, 3, 4].map((i) => Math.round(((5 - i) * a0 + i * a1) / 5)), 0, 255];
        for (let i = 5; i >= 0; i--) alphaBits = (alphaBits << 8n) | BigInt(src[o + 2 + i]!);
      }
      const co = blockBytes === 16 ? o + 8 : o;
      const palette = colors(src, co, blockBytes === 16);
      const bits = (src[co + 4]! | (src[co + 5]! << 8) | (src[co + 6]! << 16) | (src[co + 7]! << 24)) >>> 0;
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i % 4);
        const y = by * 4 + Math.floor(i / 4);
        if (x >= w || y >= h) continue;
        const c = palette[(bits >>> (2 * i)) & 3]!;
        const q = (y * w + x) * 4;
        out[q] = c[0]!;
        out[q + 1] = c[1]!;
        out[q + 2] = c[2]!;
        out[q + 3] = alpha ? alpha[Number((alphaBits >> BigInt(3 * i)) & 7n)]! : c[3]!;
      }
    }
  }
  return out;
}

export const decodeBC1 = (src: Uint8Array, w: number, h: number): Uint8Array => decodeBlocks(src, w, h, 8);
export const decodeBC3 = (src: Uint8Array, w: number, h: number): Uint8Array => decodeBlocks(src, w, h, 16);

export function mipChain(size: number): { top: number; blockBytes: 8 | 16 } | null {
  for (const blockBytes of [16, 8] as const) {
    for (let top = 1; top <= 4096; top *= 2) {
      let total = 0;
      for (let s = top; s >= 1; s >>= 1) total += Math.max(1, Math.ceil(s / 4)) ** 2 * blockBytes;
      if (total === size) return { top, blockBytes };
      if (total > size) break;
    }
  }
  return null;
}

export function downscale(rgba: Uint8Array, w: number, to: number): Uint8Array {
  const f = w / to;
  const out = new Uint8Array(to * to * 4);
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const q = ((y * f + dy) * w + (x * f + dx)) * 4;
          const pa = rgba[q + 3]!;
          r += rgba[q]! * pa;
          g += rgba[q + 1]! * pa;
          b += rgba[q + 2]! * pa;
          a += pa;
        }
      }
      const o = (y * to + x) * 4;
      if (a) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (f * f));
    }
  }
  return out;
}

export function textureImage(data: Uint8Array, size: number): { rgba: Uint8Array; side: number } | null {
  const chain = mipChain(data.length);
  if (!chain) return null;
  const { top, blockBytes } = chain;
  const bytes = Math.max(1, Math.ceil(top / 4)) ** 2 * blockBytes;
  const rgba = (blockBytes === 16 ? decodeBC3 : decodeBC1)(data.subarray(data.length - bytes), top, top);
  return top > size ? { rgba: downscale(rgba, top, size), side: size } : { rgba, side: top };
}

export class GameIcons {
  private index: Promise<Map<string, TocEntry>> | null = null;

  constructor(private readonly dir: string) {}

  private entries(): Promise<Map<string, TocEntry>> {
    return (this.index ??= readFile(join(this.dir, TEXTURES.toc)).then(tocIndex));
  }

  async has(path: string): Promise<boolean> {
    return (await this.entries()).has(path);
  }

  async png(path: string, size = 64): Promise<Buffer | null> {
    const e = (await this.entries()).get(path);
    if (!e) return null;
    const img = textureImage(await readEntry(join(this.dir, TEXTURES.cache), e), size);
    return img ? encodePng(img.rgba, img.side, img.side) : null;
  }
}
