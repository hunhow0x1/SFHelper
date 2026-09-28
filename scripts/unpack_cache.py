#!/usr/bin/env python3
"""Unpack Soulframe Cache.Windows packages (DE Evolution engine format).

Run this against the LOCAL installed cache - no multi-GB downloads:

    Cache.Windows/  contains paired files per package:
        <P>.<Name>.toc     index (directory tree + entry table)
        <P>.<Name>.cache    concatenated entry data
      where <P> is B/F/H (and _en/_xx/... for localized packages).

Format (fully reverse-engineered, confirmed against build 2026.08):
  TOC: uint32 magic 0x1867C64E, uint32 version (20), then 96-byte entries:
        int64  cacheOffset      (-1 for a directory)
        int64  timeStamp        (Windows FILETIME)
        int32  compressedSize
        int32  decompressedSize
        int32  flags
        int32  compressionType  (0 raw; 6/59/... = DE block-LZ; per entry)
        char   name[64]         (leaf name, NUL-padded)
  The .toc/.cache on the CDN are wrapped in whole-file LZMA (".lzma"); some
  .cache are served raw (".bulk"). On disk the launcher stores them
  decompressed, so this tool auto-detects an LZMA wrapper and unwraps it.

Entry payload: an entry with compressedSize == decompressedSize is stored raw
and is returned as-is. Otherwise it is compressed with DE's block-LZ codec -
see decompress_de_block(), the one piece left to port (Sainan's Warframe/
Soulframe cache tools implement exactly this).

Usage:
    unpack_cache.py list   <pkg.toc>
    unpack_cache.py search <pkg.toc> <pkg.cache> <text>   # raw entries + any decodable
    unpack_cache.py extract <pkg.toc> <pkg.cache> <name-substr> <outdir>
"""

from __future__ import annotations
import lzma
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

MAGIC = 0x1867C64E
ENTRY = 96


def _unwrap_lzma(data: bytes) -> bytes:
    """CDN files are whole-file LZMA-wrapped; on-disk files are already raw."""
    if len(data) >= 4 and struct.unpack_from("<I", data, 0)[0] == MAGIC:
        return data
    for fmt in (lzma.FORMAT_ALONE, lzma.FORMAT_AUTO):
        try:
            return lzma.decompress(data, format=fmt)
        except lzma.LZMAError:
            continue
    return data


@dataclass
class Entry:
    index: int
    offset: int
    comp_size: int
    dec_size: int
    comp_type: int
    name: str

    @property
    def is_dir(self) -> bool:
        return self.offset < 0

    @property
    def is_raw(self) -> bool:
        return self.comp_size == self.dec_size


def parse_toc(toc_bytes: bytes) -> list[Entry]:
    data = _unwrap_lzma(toc_bytes)
    magic, version = struct.unpack_from("<II", data, 0)
    if magic != MAGIC:
        raise ValueError(f"not a DE TOC (magic 0x{magic:08X})")
    body = data[8:]
    entries: list[Entry] = []
    for i in range(len(body) // ENTRY):
        e = body[i * ENTRY : (i + 1) * ENTRY]
        off, _ts = struct.unpack_from("<qq", e, 0)
        cs, ds, _flags, ct = struct.unpack_from("<iiii", e, 16)
        name = e[32:96].split(b"\x00")[0].decode("latin1", "replace")
        entries.append(Entry(i, off, cs, ds, ct, name))
    return entries


class UnsupportedCodec(Exception):
    pass


import ctypes
import os

_OODLE = None


def _load_oodle() -> "ctypes.CDLL":
    """Load Oodle (oo2core_9), which ships with the game. Point OODLE_LIB at it
    (e.g. the oo2core_9.so / oo2core_9_win64.dll in the Soulframe install)."""
    global _OODLE
    if _OODLE is not None:
        return _OODLE
    candidates = [os.environ.get("OODLE_LIB")] if os.environ.get("OODLE_LIB") else []
    candidates += ["oo2core_9.so", "./oo2core_9.so", "oo2core_9_win64.dll"]
    for cand in candidates:
        if not cand:
            continue
        try:
            _OODLE = ctypes.CDLL(cand)
            # int OodleLZ_Decompress(const char* in, size_t inLen, void* out,
            #   size_t outLen, i,i,i, size,size,size,size,size,size, int) -> from Sainan
            _OODLE.OodleLZ_Decompress.restype = ctypes.c_int
            return _OODLE
        except OSError:
            continue
    raise UnsupportedCodec(
        "Oodle library not found. Set OODLE_LIB to the game's oo2core_9 "
        "(.so on Linux/Proton, .dll on Windows)."
    )


def _oodle_decompress(chunk: bytes, dec_size: int) -> bytes:
    lib = _load_oodle()
    out = ctypes.create_string_buffer(dec_size)
    n = lib.OodleLZ_Decompress(
        chunk, ctypes.c_size_t(len(chunk)), out, ctypes.c_size_t(dec_size),
        0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
    )
    if n <= 0:
        raise UnsupportedCodec(f"OodleLZ_Decompress failed (returned {n})")
    return out.raw[:dec_size]


def decompress_de_block(blob: bytes, dec_size: int) -> bytes:
    """Decompress a DE cache entry (Oodle inside 8-byte block headers).

    Ported from Sainan's warframe-cache-tools (shcc_decompress_chunk_oodle):
    the entry is a sequence of blocks, each an 8-byte big-endian header
    (byte0 == 0x80, byte7 & 0x0F == 0x01) carrying the block's compressed and
    decompressed sizes, followed by an Oodle stream (starts 0x8C).
    """
    out = bytearray()
    i = 0
    while len(out) < dec_size:
        info = blob[i:i + 8]
        i += 8
        if len(info) < 8 or info[0] != 0x80 or (info[7] & 0x0F) != 0x01:
            raise UnsupportedCodec(f"unexpected block header {info[:8].hex()}")
        num1 = int.from_bytes(info[0:4], "big")
        num2 = int.from_bytes(info[4:8], "big")
        block_comp = (num1 >> 2) & 0xFFFFFF
        block_dec = (num2 >> 5) & 0xFFFFFF
        chunk = blob[i:i + block_comp]
        i += block_comp
        out += _oodle_decompress(chunk, block_dec)
    return bytes(out[:dec_size])


def read_entry(cache: bytes, e: Entry) -> bytes:
    if e.is_dir:
        raise ValueError("directory entry has no data")
    blob = cache[e.offset : e.offset + e.comp_size]
    if e.is_raw:
        return blob
    return decompress_de_block(blob, e.dec_size)


def _load(path: str) -> bytes:
    return Path(path).read_bytes()


def cmd_list(toc_path: str) -> int:
    entries = parse_toc(_load(toc_path))
    files = [e for e in entries if not e.is_dir]
    dirs = len(entries) - len(files)
    raw = sum(1 for e in files if e.is_raw)
    print(f"{len(entries)} entries: {len(files)} files ({raw} raw, "
          f"{len(files) - raw} compressed), {dirs} dirs")
    for e in files[:50]:
        kind = "raw" if e.is_raw else f"c{e.comp_type}"
        print(f"  [{e.index}] {e.name}  {e.comp_size}->{e.dec_size} {kind}")
    if len(files) > 50:
        print(f"  ... {len(files) - 50} more")
    return 0


def cmd_search(toc_path: str, cache_path: str, needle: str) -> int:
    entries = parse_toc(_load(toc_path))
    cache = _unwrap_lzma(_load(cache_path))
    target = needle.encode("utf-8")
    hits = skipped = 0
    for e in entries:
        if e.is_dir:
            continue
        try:
            data = read_entry(cache, e)
        except UnsupportedCodec:
            skipped += 1
            continue
        if target in data:
            hits += 1
            i = data.find(target)
            ctx = data[max(0, i - 40) : i + 60].decode("latin1", "replace")
            print(f"  HIT [{e.index}] {e.name}: ...{ctx}...")
    print(f"\n{hits} hits; {skipped} compressed entries skipped "
          f"(need decompress_de_block).")
    return 0


def cmd_extract(toc_path: str, cache_path: str, substr: str, outdir: str) -> int:
    entries = parse_toc(_load(toc_path))
    cache = _unwrap_lzma(_load(cache_path))
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    n = skipped = 0
    for e in entries:
        if e.is_dir or substr not in e.name:
            continue
        try:
            data = read_entry(cache, e)
        except UnsupportedCodec:
            skipped += 1
            continue
        (out / f"{e.index}_{e.name}").write_bytes(data)
        n += 1
    print(f"extracted {n} file(s) to {outdir}; {skipped} skipped (compressed).")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    try:
        if cmd == "list" and len(argv) == 3:
            return cmd_list(argv[2])
        if cmd == "search" and len(argv) == 5:
            return cmd_search(argv[2], argv[3], argv[4])
        if cmd == "extract" and len(argv) == 6:
            return cmd_extract(argv[2], argv[3], argv[4], argv[5])
    except (ValueError, OSError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
