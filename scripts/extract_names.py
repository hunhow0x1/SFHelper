#!/usr/bin/env python3
"""Extract Soulframe's in-game name dictionary into a names file.

Ported from Sainan's warframe-cache-tools (lib/cachelib.pluto) for Soulframe.
The display names live in Languages.bin (per-language), NOT in Cache.Windows -
a zstd-with-custom-dictionary format reached through a chain of manifests:

    H.Cache.bin  ->  B.Cache.Windows_<lang>.bin  ->  Languages.bin  (suffix _<lang>)

Each downloaded file is an SHCC container whose chunks are Oodle-compressed
(the same 8-byte-header + oo2core codec as Cache.Windows entries). The final
Languages.bin H-chunk is parsed into { "<path><name>": "<display string>" }.

Runtime dependencies (both native, loaded via ctypes):
  * Oodle  - oo2core_9, ships with the game. Set OODLE_LIB to its path
             (.so on Linux/Proton, .dll on Windows).
  * libzstd - system library (Linux has /usr/lib64/libzstd.so). Set ZSTD_LIB
             to override.

Usage:
    OODLE_LIB=/path/to/oo2core_9.so extract_names.py [--lang en] [--out dict.en.json]

Output is the full localization dict as JSON. Grep it for a known name (e.g.
"Igne Mora") to confirm the key convention, then map keys to the app's
{ items, factions } names file.
"""

from __future__ import annotations
import argparse
import base64
import ctypes
import json
import os
import struct
import sys
import urllib.request
from pathlib import Path

MAGIC_SHCC = b"SHCC"
TYPE_MANIFEST = 0xE
TYPE_BIN = 0x2C
CONTENT_HOST = "http://content.soulframe.com"
ORIGIN_HOST = "http://origin.soulframe.com"
USER_AGENT = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)"
# Local mirror of downloaded manifest/bin H-chunks, like cachelib's data/0 dir.
DATA_DIR = Path(os.environ.get("SFHELPER_CACHE_DIR", Path.home() / ".cache" / "sfhelper-cache"))

# ---------------------------------------------------------------------------
# Oodle (oo2core_9) via ctypes - same codec as scripts/unpack_cache.py.
# ---------------------------------------------------------------------------
_OODLE = None


def _oodle():
    global _OODLE
    if _OODLE is None:
        for cand in [os.environ.get("OODLE_LIB"), "oo2core_9.so", "./oo2core_9.so"]:
            if not cand:
                continue
            try:
                _OODLE = ctypes.CDLL(cand)
                _OODLE.OodleLZ_Decompress.restype = ctypes.c_int
                break
            except OSError:
                continue
        if _OODLE is None:
            sys.exit("Oodle not found. Set OODLE_LIB to the game's oo2core_9 library.")
    return _OODLE


def oodle_decompress(chunk: bytes, dec_size: int) -> bytes:
    out = ctypes.create_string_buffer(dec_size)
    n = _oodle().OodleLZ_Decompress(
        chunk, ctypes.c_size_t(len(chunk)), out, ctypes.c_size_t(dec_size),
        0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
    )
    if n <= 0:
        raise RuntimeError(f"OodleLZ_Decompress failed ({n})")
    return out.raw[:dec_size]


def _oodle_blocks(bin_: bytes, i: int, dec_size: int) -> tuple[bytes, int]:
    """Decode a run of Oodle blocks (shcc_decompress_chunk_oodle)."""
    out = bytearray()
    while len(out) < dec_size:
        info = bin_[i:i + 8]
        i += 8
        assert info[0] == 0x80 and (info[7] & 0x0F) == 0x01, f"bad block {info.hex()}"
        num1 = int.from_bytes(info[0:4], "big")
        num2 = int.from_bytes(info[4:8], "big")
        bcs = (num1 >> 2) & 0xFFFFFF
        bds = (num2 >> 5) & 0xFFFFFF
        out += oodle_decompress(bin_[i:i + bcs], bds)
        i += bcs
    return bytes(out[:dec_size]), i


# ---------------------------------------------------------------------------
# SHCC container (shcc_decompress_chunk / shcc_unpack).
# ---------------------------------------------------------------------------
def _shcc_chunk(bin_: bytes, i: int) -> tuple[bytes, int]:
    chunk_type = bin_[i]
    dec_size, comp_size = struct.unpack_from("<II", bin_, i + 1)
    i += 9
    if chunk_type == 0:
        assert comp_size == dec_size
        return bin_[i:i + comp_size], i + dec_size
    assert chunk_type == 2, f"unknown SHCC chunk type {chunk_type}"
    return _oodle_blocks(bin_, i, dec_size)


def shcc_unpack(bin_: bytes) -> tuple[bytes, bytes | None]:
    """Return (H_chunk, B_chunk_or_None) from an SHCC container."""
    if bin_[:4] != MAGIC_SHCC:
        # Rarely the whole file is Oodle-compressed first.
        bin_ = oodle_decompress(bin_, len(bin_) * 10)
    i = 8
    h, i = _shcc_chunk(bin_, i)
    b = None
    try:
        b, _ = _shcc_chunk(bin_, i)
    except (AssertionError, IndexError, RuntimeError):
        pass
    return h, b


# ---------------------------------------------------------------------------
# Manifest (CacheManifest): path -> content hash.
# ---------------------------------------------------------------------------
def b64m_encode(data: bytes) -> str:
    return base64.b64encode(data).decode().rstrip("=").replace("/", "-")


def parse_manifest(h_chunk: bytes) -> dict[str, bytes]:
    """Parse a manifest H-chunk into { path: 16-byte hash }."""
    i = 20  # skip header
    hashes: dict[str, bytes] = {}
    n = len(h_chunk)
    while i < n:
        remaining = 0
        while remaining == 0 and i < n:
            remaining = struct.unpack_from("<I", h_chunk, i)[0]
            i += 4
        for _ in range(remaining):
            if i >= n:
                break
            (plen,) = struct.unpack_from("<I", h_chunk, i)
            i += 4
            path = h_chunk[i:i + plen].decode("latin1")
            i += plen
            hashes[path] = h_chunk[i:i + 16]
            i += 20  # 16 hash + 4 unk
    return hashes


# ---------------------------------------------------------------------------
# Download flow (download_file).
# ---------------------------------------------------------------------------
def _http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"user-agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def download_h(path: str, type_id: int, b64m_hash: str = "---------------------w",
               suffix: str = "") -> bytes:
    """Download a file, unpack its SHCC container, cache and return the H-chunk."""
    local = DATA_DIR / f"0{suffix}{path}_H"
    if local.exists():
        return local.read_bytes()

    req_path = f"/0{suffix}{path}!{type_id:X}_{b64m_hash}"
    if req_path == "/0/H.Cache.bin!E_---------------------w":
        import random
        url = f"{ORIGIN_HOST}/origin/{random.randint(0, 0xffffffff):08X}{req_path}"
    else:
        url = CONTENT_HOST + req_path
    print(f"Downloading {url}", file=sys.stderr)
    raw = _http_get(url)
    h, _b = shcc_unpack(raw)
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_bytes(h)
    return h


# ---------------------------------------------------------------------------
# zstd (with custom dictionary) and Languages.bin parser (languages_unpack).
# ---------------------------------------------------------------------------
_ZSTD = None


def _zstd():
    global _ZSTD
    if _ZSTD is None:
        for cand in [os.environ.get("ZSTD_LIB"), "libzstd.so.1", "/usr/lib64/libzstd.so",
                     "libzstd.so"]:
            if not cand:
                continue
            try:
                _ZSTD = ctypes.CDLL(cand)
                break
            except OSError:
                continue
        if _ZSTD is None:
            sys.exit("libzstd not found. Set ZSTD_LIB.")
        _ZSTD.ZSTD_createDDict.restype = ctypes.c_void_p
        _ZSTD.ZSTD_createDDict.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
        _ZSTD.ZSTD_createDCtx.restype = ctypes.c_void_p
        _ZSTD.ZSTD_DCtx_setParameter.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
        _ZSTD.ZSTD_decompress_usingDDict.restype = ctypes.c_size_t
        _ZSTD.ZSTD_decompress_usingDDict.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
            ctypes.c_char_p, ctypes.c_size_t, ctypes.c_void_p,
        ]
    return _ZSTD


def _u32_dyn_le(bin_: bytes, i: int) -> tuple[int, int]:
    """LEB128-style varint (unpack_u32_dyn_le)."""
    value = shift = 0
    while shift < 28:
        byte = bin_[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, i
        shift += 7
    value |= bin_[i] << shift
    return value, i + 1


def languages_unpack(bin_: bytes) -> dict[str, str]:
    z = _zstd()
    i = 16 + 4 + 4 + 4  # hash, 0x14, 0x2B, 0x01
    (num_suffixes,) = struct.unpack_from("<I", bin_, i)
    i += 4
    for _ in range(num_suffixes):
        (slen,) = struct.unpack_from("<I", bin_, i)
        i += 4 + slen
    (dict_len,) = struct.unpack_from("<I", bin_, i)
    i += 4
    dict_bin = bin_[i:i + dict_len]
    i += dict_len
    (num_paths,) = struct.unpack_from("<I", bin_, i)
    i += 4

    ddict = z.ZSTD_createDDict(dict_bin, len(dict_bin))
    ctx = z.ZSTD_createDCtx()
    z.ZSTD_DCtx_setParameter(ctx, 1000, 1)

    entries: dict[str, str] = {}
    for _ in range(num_paths):
        (plen,) = struct.unpack_from("<I", bin_, i)
        i += 4
        path = bin_[i:i + plen].decode("latin1")
        i += plen
        (clen,) = struct.unpack_from("<I", bin_, i)
        i += 4
        chunk = bin_[i:i + clen]
        i += clen
        (num_labels,) = struct.unpack_from("<I", bin_, i)
        i += 4
        for _ in range(num_labels):
            (nlen,) = struct.unpack_from("<I", bin_, i)
            i += 4
            name = bin_[i:i + nlen].decode("latin1")
            i += nlen
            offset, size, flags = struct.unpack_from("<IHH", bin_, i)
            i += 8
            data = chunk[offset:offset + size]
            if flags & 0x200:
                dec_size, di = _u32_dyn_le(data, 0)
                out = ctypes.create_string_buffer(dec_size)
                got = z.ZSTD_decompress_usingDDict(
                    ctx, out, dec_size, data[di:], len(data) - di, ddict)
                if got != dec_size:
                    raise RuntimeError(f"zstd dict decompress size {got} != {dec_size}")
                data = out.raw[:dec_size]
            entries[path + name] = data.decode("utf-8", "replace")

    z.ZSTD_freeDCtx(ctx)
    z.ZSTD_freeDDict(ddict)
    return entries


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Extract Soulframe name dictionary.")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--out", default="dict.en.json")
    args = ap.parse_args(argv)
    suffix = f"_{args.lang}"

    # H.Cache.bin (root) -> B.Cache.Windows_<lang>.bin (lang manifest) -> Languages.bin
    meta_h = download_h("/H.Cache.bin", TYPE_MANIFEST)
    meta = parse_manifest(meta_h)

    lang_bin_path = f"/B.Cache.Windows{suffix}.bin"
    lang_hash = meta.get(lang_bin_path)
    if not lang_hash:
        return _fail(f"{lang_bin_path} not in root manifest")
    lang_h = download_h(lang_bin_path, TYPE_MANIFEST, b64m_encode(lang_hash))
    lang_mf = parse_manifest(lang_h)

    languages_hash = lang_mf.get("/Languages.bin")
    if not languages_hash:
        return _fail("/Languages.bin not in language manifest")
    languages_h = download_h("/Languages.bin", TYPE_BIN, b64m_encode(languages_hash), suffix)

    entries = languages_unpack(languages_h)
    Path(args.out).write_text(json.dumps(entries, indent=2, ensure_ascii=False, sort_keys=True))
    print(f"Wrote {len(entries)} entries to {args.out}", file=sys.stderr)
    return 0


def _fail(msg: str) -> int:
    print(f"error: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
