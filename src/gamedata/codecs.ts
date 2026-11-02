import { decompress as oozDecompress } from "ooz-wasm";
import { createDCtx, decompressUsingDict, freeDCtx, init as zstdInit } from "@bokuweb/zstd-wasm";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export const breathe = (): Promise<void> => new Promise((r) => setImmediate(r));

export function uleb(buf: Uint8Array, i: number): [number, number] {
  let v = 0;
  let shift = 0;
  let c: number;
  do {
    c = buf[i++] ?? 0;
    v |= (c & 0x7f) << shift;
    shift += 7;
  } while (c & 0x80 && shift < 35);
  return [v >>> 0, i];
}

export async function oodleBlocks(buf: Buffer, decSize: number): Promise<Buffer> {
  const out: Buffer[] = [];
  let have = 0;
  let i = 0;
  while (have < decSize) {
    if (i + 8 > buf.length) throw new Error("Oodle data ends early");
    const info = buf.subarray(i, i + 8);
    i += 8;
    if (info[0] !== 0x80 || ((info[7] ?? 0) & 0x0f) !== 0x01) throw new Error(`bad Oodle block header ${info.toString("hex")}`);
    const blockComp = (info.readUInt32BE(0) >>> 2) & 0xffffff;
    const blockDec = (info.readUInt32BE(4) >>> 5) & 0xffffff;
    out.push(Buffer.from(oozDecompress(buf.subarray(i, i + blockComp), blockDec)));
    i += blockComp;
    have += blockDec;
    await breathe();
  }
  return Buffer.concat(out).subarray(0, decSize);
}

let zstd: Promise<void> | null = null;

export class ZstdDict {
  private constructor(
    private readonly dict: Uint8Array,
    private readonly dctx: number,
  ) {}

  static async load(dictionary: Uint8Array): Promise<ZstdDict> {
    await (zstd ??= zstdInit());
    return new ZstdDict(dictionary, createDCtx());
  }

  decompress(frame: Uint8Array, size: number): Buffer | null {
    try {
      const out = decompressUsingDict(this.dctx, Buffer.concat([ZSTD_MAGIC, frame]), this.dict, { defaultHeapSize: Math.max(1, size) });
      return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    } catch {
      return null;
    }
  }

  free(): void {
    freeDCtx(this.dctx);
  }
}
