#!/usr/bin/env python3
"""Stream a file as animated, fountain-coded QR codes in a terminal.

The receiver is a browser: https://hish-l.github.io/transfer/receive/

This is a port of the browser sender's wire format, and "port" is meant
strictly — the receiver derives every frame's block subset independently and
never compares notes with the sender, so any arithmetic that differs by one
ulp desynchronises the two silently. The transfer just never completes. See
PARITY in the fountain section for the specific rules that keeps.

Pure standard library, deliberately: this file is fetched over the network and
run, so every dependency it might have had is a thing you would have to trust
and install first.
"""

from __future__ import annotations

import argparse
import atexit
import bisect
import gzip
import hashlib
from itertools import groupby
import math
import mimetypes
import os
import select
import signal
import struct
import subprocess
import sys
import time

VERSION = "0.1.0"
RECEIVER_URL = "https://hish-l.github.io/transfer/receive/"

# =============================================================================
# Wire format
# =============================================================================

HEADER_LEN = 20
MAGIC0 = 0xD1
MAGIC1 = 0x0C
MAX_SOURCE_BLOCKS = 0xFFFF
MAX_FILE_BYTES = 64 * 1024 * 1024

FILE_HEADER_LEN = 49
FILE_MAGIC = b"DCF2"

SNIPPET_MEDIA_TYPE = "application/vnd.qrtransfer.snippet"
SNIPPET_FILE_NAME = "snippet.txt"

_FRAME_STRUCT = struct.Struct("<BBHIHHII")
_FILE_STRUCT = struct.Struct("<4sBHHII32s")
assert _FRAME_STRUCT.size == HEADER_LEN, "frame header must be exactly 20 bytes"
assert _FILE_STRUCT.size == FILE_HEADER_LEN, "file header must be exactly 49 bytes"

U32 = 0xFFFFFFFF


def fnv1a(data: bytes) -> int:
    h = 0x811C9DC5
    for byte in data:
        h ^= byte
        h = (h * 0x01000193) & U32
    return h


def pack_frame(session_id: int, seq: int, k: int, block_len: int,
               total_len: int, payload_fnv: int, block: bytes) -> bytes:
    return _FRAME_STRUCT.pack(
        MAGIC0, MAGIC1, session_id, seq, k, block_len, total_len, payload_fnv
    ) + block


# =============================================================================
# Fountain code  (LT / Luby transform, robust soliton)
# =============================================================================
#
# PARITY. Everything below is wire format, not implementation. The rules that
# keep this bit-identical to the browser's fountain.ts:
#
#   * Every 32-bit value is held as an unsigned int in [0, 2**32) and masked
#     after every operation. JavaScript's `| 0` and `>>> 0` then become no-ops:
#     +, ^ and imul are all congruent mod 2**32 regardless of signedness, and
#     `>>>` is the only place the interpretation is observable.
#   * Math.imul(a, b) is (a * b) & 0xFFFFFFFF.
#   * dlog's series is 11 terms. Nineteen changes 0.2% of its outputs.
#   * solitonCdf accumulates `total += rho + tau` as ONE add. Splitting it into
#     two += changes the last bit and therefore the sampled degree.
#   * The `d > k >> 3` branch consumes different numbers of PRNG outputs on
#     each side, so it is protocol, not an optimisation.
#   * The small-degree branch needs insertion order, which is dict, not set.
#
# CPython floats are IEEE-754 binary64 with the same rounding as every JS
# engine, and no x87 or FMA surprises, so the float arithmetic ports directly.

LN2 = 0.6931471805599453
SOLITON_C = 0.1
SOLITON_DELTA = 0.5


def dlog(x: float) -> float:
    """Deterministic natural log: exact-op range reduction + atanh series.

    math.log is a libm call whose last bit is not specified, so a Linux sender
    and an iPhone receiver can disagree by an ulp — enough to move a CDF
    boundary and flip a sampled degree. This uses only operations IEEE-754
    pins exactly.
    """
    e = 0
    m = x
    while m >= 1.5:
        m /= 2
        e += 1
    while m < 0.75:
        m *= 2
        e -= 1
    z = (m - 1) / (m + 1)
    z2 = z * z
    term = z
    total = 0.0
    for n in range(1, 22, 2):
        total += term / n
        term *= z2
    return e * LN2 + 2 * total


def soliton_cdf(k: int) -> list[float]:
    """Robust-soliton degree CDF for k source blocks."""
    if k == 1:
        return [1.0]
    # Left-to-right associativity, matching the JS. Regrouping this changes
    # the rounding.
    r = max(1.0, SOLITON_C * dlog(k / SOLITON_DELTA) * math.sqrt(k))
    spike = min(k, math.ceil(k / r))
    cdf = [0.0] * k
    total = 0.0
    for d in range(1, k + 1):
        rho = 1 / k if d == 1 else 1 / (d * (d - 1))
        tau = 0.0
        if d < spike:
            tau = r / (d * k)
        elif d == spike:
            tau = (r * max(0.0, dlog(r / SOLITON_DELTA))) / k
        total += rho + tau
        cdf[d - 1] = total
    for i in range(k):
        cdf[i] = cdf[i] / total
    cdf[k - 1] = 1.0
    return cdf


def splitmix32(seed: int):
    """splitmix32 — integer ops only, so it is identical across languages."""
    s = seed & U32

    def rnd() -> int:
        nonlocal s
        s = (s + 0x9E3779B9) & U32
        t = s ^ (s >> 16)
        t = (t * 0x21F0AAAD) & U32
        t ^= t >> 15
        t = (t * 0x735A2D97) & U32
        t ^= t >> 15
        return t & U32

    return rnd


def frame_seed(session_id: int, seq: int) -> int:
    # The `& U32` on the addend is load-bearing: JS truncates here via ToInt32,
    # so without it the two diverge once seq passes 2**31.
    h = ((((session_id + 1) * 0x9E3779B1) & U32) ^ ((seq + 0x85EBCA6B) & U32)) & U32
    h = ((h ^ (h >> 13)) * 0xC2B2AE35) & U32
    return (h ^ (h >> 16)) & U32


def frame_indices(k: int, cdf: list[float], session_id: int, seq: int) -> list[int]:
    """The block indices XORed into frame `seq`."""
    rnd = splitmix32(frame_seed(session_id, seq))
    # inverse-CDF sample the degree. bisect_left finds the first index with
    # cdf[i] >= u, which is exactly what the JS binary search computes,
    # including under ties.
    u = rnd() * 2.0**-32
    d = min(k, min(bisect.bisect_left(cdf, u), k - 1) + 1)

    if d > k >> 3:
        # large degree: partial Fisher-Yates over an identity array
        scratch = list(range(k))
        out = []
        for i in range(d):
            j = i + (rnd() % (k - i))
            scratch[i], scratch[j] = scratch[j], scratch[i]
            out.append(scratch[i])
        return out
    # small degree: rejection sampling. dict, not set — the JS uses a Set,
    # whose iteration order is insertion order, and a Python set's is not.
    seen: dict[int, None] = {}
    while len(seen) < d:
        seen[rnd() % k] = None
    return list(seen)


class LTEncoder:
    """Endless stream of XOR combinations of the payload's blocks.

    Blocks are held as Python big integers, which makes the per-frame XOR one
    C loop over 30-bit digits with no per-word interpreter overhead: about
    4 microseconds for a degree-9 frame over 2933-byte blocks, versus ~0.9 ms
    for the obvious array('I') loop.
    """

    def __init__(self, payload: bytes, block_len: int, session_id: int):
        self.block_len = block_len
        self.session_id = session_id
        self.k = max(1, -(-len(payload) // block_len))
        # Blocks are word-aligned internally, matching the JS Uint32Array
        # layout the golden vectors were recorded against. The padding is never
        # transmitted, but it is what the tail block's zero-fill rides on.
        self.words = -(-block_len // 4)
        self.byte_width = self.words * 4
        buf = bytearray(self.k * self.byte_width)
        for b in range(self.k):
            chunk = payload[b * block_len : (b + 1) * block_len]
            start = b * self.byte_width
            buf[start : start + len(chunk)] = chunk
        self.blocks = [
            int.from_bytes(buf[b * self.byte_width : (b + 1) * self.byte_width], "little")
            for b in range(self.k)
        ]
        del buf
        self.cdf = soliton_cdf(self.k)

    def encode(self, seq: int) -> bytes:
        acc = 0
        for b in frame_indices(self.k, self.cdf, self.session_id, seq):
            acc ^= self.blocks[b]
        return acc.to_bytes(self.byte_width, "little")[: self.block_len]


# =============================================================================
# File container
# =============================================================================

# Formats gzip cannot help with. Ported verbatim from the browser so the two
# senders produce the same container for the same file — the receiver does not
# care either way, but a divergence here would make their sizes incomparable
# and quietly invalidate any benchmark run across both.
_PRECOMPRESSED = {
    "application/zip", "application/gzip", "application/x-gzip",
    "application/x-rar-compressed", "application/vnd.rar",
    "application/x-7z-compressed", "application/x-tar+gzip",
    "application/x-bzip", "application/x-bzip2", "application/x-xz",
    "application/x-lzma", "application/zstd", "application/java-archive",
    "application/x-brotli", "application/x-compress",
}
_COMPRESSIBLE_IMAGES = {
    "image/bmp", "image/x-ms-bmp", "image/svg+xml", "image/tiff",
    "image/x-icon", "image/vnd.microsoft.icon",
}
_COMPRESSIBLE_AUDIO = {
    "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave",
    "audio/aiff", "audio/x-aiff", "audio/basic", "audio/l16",
}


def is_precompressed_type(media_type: str) -> bool:
    media = media_type.split(";")[0].strip().lower()
    if media.startswith("video/"):
        return True
    if media.startswith("image/"):
        return media not in _COMPRESSIBLE_IMAGES
    if media.startswith("audio/"):
        return media not in _COMPRESSIBLE_AUDIO
    # The OOXML and OpenDocument families are zip containers.
    if media.startswith("application/vnd.openxmlformats-officedocument."):
        return True
    if media.startswith("application/vnd.oasis.opendocument."):
        return True
    if media.endswith("+zip"):
        return True
    return media in _PRECOMPRESSED


def safe_file_name(name: str) -> str:
    base = name.replace("\\", "/").split("/")[-1]
    base = "".join(c for c in base if not (ord(c) < 0x20 or ord(c) == 0x7F)).strip()
    return base or "flight.bin"


def guess_media_type(path: str) -> str:
    # mimetypes reads /etc/mime.types on some systems, so it is not
    # deterministic machine to machine. The overrides pin the cases people
    # actually hit; the rest is best-effort and the receiver does not depend
    # on it being right.
    overrides = {
        ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
        ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
        ".zip": "application/zip", ".gz": "application/gzip",
        ".mp4": "video/mp4", ".mov": "video/quicktime", ".csv": "text/csv",
        ".log": "text/plain", ".yaml": "text/yaml", ".yml": "text/yaml",
        ".sh": "text/x-shellscript", ".py": "text/x-python",
    }
    ext = os.path.splitext(path)[1].lower()
    if ext in overrides:
        return overrides[ext]
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


class Packed:
    __slots__ = ("container", "compression", "original_size", "transmitted_size",
                 "name", "media_type")

    def __init__(self, container, compression, original_size, transmitted_size,
                 name, media_type):
        self.container = container
        self.compression = compression
        self.original_size = original_size
        self.transmitted_size = transmitted_size
        self.name = name
        self.media_type = media_type


def pack_file(name: str, media_type: str, data: bytes, allow_gzip: bool = True) -> Packed:
    if len(data) == 0:
        raise ValueError("there is nothing to send — that file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(
            f"{human_bytes(len(data))} is over the {MAX_FILE_BYTES // 1024 // 1024} MB limit."
        )

    name_bytes = safe_file_name(name).encode("utf-8")
    type_bytes = (media_type or "application/octet-stream").encode("utf-8")
    if len(name_bytes) > 0xFFFF or len(type_bytes) > 0xFFFF:
        raise ValueError("the file name or media type is too long.")

    sha = hashlib.sha256(data).digest()

    # Too small to be worth a gzip header, or a format gzip cannot help with.
    use_gzip = False
    transmitted = data
    if allow_gzip and len(data) >= 768 and not is_precompressed_type(media_type):
        # mtime=0 so the container is reproducible — the same file packed twice
        # is the same bytes, which is what makes the loopback test meaningful.
        compressed = gzip.compress(data, compresslevel=6, mtime=0)
        if len(compressed) + 64 < len(data):
            use_gzip = True
            transmitted = compressed

    header = _FILE_STRUCT.pack(
        FILE_MAGIC, 1 if use_gzip else 0, len(name_bytes), len(type_bytes),
        len(data), len(transmitted), sha,
    )
    return Packed(
        container=header + name_bytes + type_bytes + transmitted,
        compression="gzip" if use_gzip else "none",
        original_size=len(data),
        transmitted_size=len(transmitted),
        name=safe_file_name(name),
        media_type=media_type,
    )


# =============================================================================
# Formatting helpers
# =============================================================================


def human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def human_duration(seconds: float) -> str:
    total = max(1, math.ceil(seconds))
    if total < 60:
        return f"{total}s"
    minutes, rest = divmod(total, 60)
    if minutes < 60:
        return f"{minutes}m" if rest == 0 else f"{minutes}m {rest}s"
    hours, rest_minutes = divmod(minutes, 60)
    return f"{hours}h" if rest_minutes == 0 else f"{hours}h {rest_minutes}m"


def expected_overhead(k: int) -> float:
    """Distinct frames per source block an LT stream needs, as a function of k.

    The often-quoted 1.15 is asymptotic. Measured p50 runs from 1.44 at k=25
    down to 1.12 at k=3200, so a flat constant misquotes short transfers badly.
    """
    return min(1.6, max(1.15, 1.1 + 2.45 / math.sqrt(max(1, k))))


# =============================================================================
# QR encoder  (byte mode, versions 1-40, mask 4)
# =============================================================================
#
# Only what this program needs: a single byte-mode segment, no ECI, no Kanji,
# no structured append.
#
# The mask pattern is hardcoded to 4, matching the browser sender. That is not
# a shortcut with a cost — the chosen mask travels in the format information
# and every conformant decoder reads it from there, so the spec's mask
# selection is purely an encoder-side optimisation. Dropping it removes the
# four penalty rules and eight trial layouts, and the payload here is
# fountain-XORed data with no structure for a bad mask to amplify anyway.

MASK_PATTERN = 4
ECC_LEVELS = ("L", "M", "Q", "H")
_ECL_INDEX = {"L": 0, "M": 1, "Q": 2, "H": 3}
# The format-info bits for each level, which are NOT its index.
_ECL_FORMAT_BITS = {"L": 1, "M": 0, "Q": 3, "H": 2}
MIN_VERSION, MAX_VERSION = 1, 40

# ISO/IEC 18004 Table 9, indexed [ecl][version]. There is no formula for
# either of these; they are the only tables here that must be verbatim, which
# is why tests/test_qr.py compares all 160 version x level combinations
# against node-qrcode. A typo in one cell is otherwise near-undetectable: it
# produces a QR that scans fine until the one payload length that trips it.
_ECC_CODEWORDS_PER_BLOCK = (
    (-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28,
     30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    (-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28,
     28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28),
    (-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30,
     30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    (-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24,
     30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
)
_NUM_ECC_BLOCKS = (
    (-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13,
     14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25),
    (-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
     25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49),
    (-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29,
     34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68),
    (-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
     37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81),
)


def raw_data_modules(version: int) -> int:
    """Modules available for data and ECC, function patterns excluded.

    Derived rather than tabulated — the ISO formula is exact for all 40
    versions and a 40-row table is 40 more chances to fat-finger a digit.
    """
    result = (16 * version + 128) * version + 64
    if version >= 2:
        align = version // 7 + 2
        result -= (25 * align - 10) * align - 55
        if version >= 7:
            result -= 36
    return result


def data_codewords(version: int, ecl: str) -> int:
    e = _ECL_INDEX[ecl]
    return (
        raw_data_modules(version) // 8
        - _ECC_CODEWORDS_PER_BLOCK[e][version] * _NUM_ECC_BLOCKS[e][version]
    )


def byte_capacity(version: int, ecl: str) -> int:
    """Payload bytes a single byte-mode segment holds at this version+level."""
    # 4 bits of mode indicator plus the character count: 8 bits below v10,
    # 16 from v10 up. Both round up to a whole number of codewords here.
    overhead = 2 if version <= 9 else 3
    return data_codewords(version, ecl) - overhead


def alignment_positions(version: int) -> list[int]:
    """Row/column centres of the alignment patterns. Also derived."""
    if version == 1:
        return []
    count = version // 7 + 2
    # Version 32 is the one case the general formula gets wrong.
    step = 26 if version == 32 else ((4 * version + 2 * count + 1) // (2 * count - 2)) * 2
    size = 4 * version + 17
    result = [6]
    pos = size - 7
    while len(result) < count:
        result.insert(1, pos)
        pos -= step
    return result


# --- GF(256) ----------------------------------------------------------------
# Built at import from the QR primitive polynomial 0x11D with generator 2.

_GF_EXP = [0] * 512
_GF_LOG = [0] * 256
_x = 1
for _i in range(255):
    _GF_EXP[_i] = _x
    _GF_LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _GF_EXP[_i] = _GF_EXP[_i - 255]


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


def _rs_generator_logs(degree: int) -> list[int]:
    """Generator polynomial coefficients, stored as their GF logs.

    The polynomial is the product of (x - 2^i) for i in [0, degree). Its
    coefficients are held highest-power-first with the constant term last, and
    every one of them is non-zero, so taking logs up front is safe — and it
    turns the encoder's inner loop into one table lookup and an XOR, with no
    log() per term.
    """
    coefficients = [0] * degree
    coefficients[degree - 1] = 1
    root = 1
    for _ in range(degree):
        for j in range(degree):
            coefficients[j] = _gf_mul(coefficients[j], root)
            if j + 1 < degree:
                coefficients[j] ^= coefficients[j + 1]
        root = _gf_mul(root, 0x02)
    return [_GF_LOG[c] for c in coefficients]


def _rs_remainder(data: bytes, gen_logs: list[int]) -> bytearray:
    degree = len(gen_logs)
    result = bytearray(degree)
    exp = _GF_EXP
    log = _GF_LOG
    for byte in data:
        factor = byte ^ result[0]
        del result[0]
        result.append(0)
        if factor:
            lf = log[factor]
            for i in range(degree):
                result[i] ^= exp[lf + gen_logs[i]]
    return result


def _bch(data: int, generator: int, gen_bits: int, xor_mask: int = 0) -> int:
    rem = data
    for _ in range(gen_bits):
        rem = (rem << 1) ^ ((rem >> (gen_bits - 1)) * generator)
    return ((data << gen_bits) | rem) ^ xor_mask


# Format info is a compile-time constant per level once the mask is pinned.
# It is still computed rather than written down, and then checked against the
# literals — which self-tests the BCH routine that version info also uses.
_FORMAT_BITS = {
    ecl: _bch((_ECL_FORMAT_BITS[ecl] << 3) | MASK_PATTERN, 0x537, 10, 0x5412)
    for ecl in ECC_LEVELS
}
assert _FORMAT_BITS == {"L": 0x662F, "M": 0x45F9, "Q": 0x24B4, "H": 0x0762}, (
    "format-info BCH is wrong — every code this produces would be unreadable"
)


class QrTemplate:
    """Everything about a (version, level) that does not depend on the payload.

    Built once per stream. The per-frame path then does Reed-Solomon, then
    walks a precomputed list of (module index, mask bit) — no function-pattern
    drawing, no mask evaluation, no penalty scoring.
    """

    def __init__(self, version: int, ecl: str):
        if not MIN_VERSION <= version <= MAX_VERSION:
            raise ValueError(f"QR version {version} is out of range")
        self.version = version
        self.ecl = ecl
        self.size = size = 4 * version + 17
        e = _ECL_INDEX[ecl]
        self.ecc_per_block = _ECC_CODEWORDS_PER_BLOCK[e][version]
        self.num_blocks = _NUM_ECC_BLOCKS[e][version]
        self.data_codewords = data_codewords(version, ecl)
        self.capacity = byte_capacity(version, ecl)
        self.total_codewords = raw_data_modules(version) // 8
        self._gen_logs = _rs_generator_logs(self.ecc_per_block)

        modules = bytearray(size * size)
        reserved = bytearray(size * size)
        self._draw_function_patterns(modules, reserved)
        self._draw_format_info(modules, reserved)
        self._draw_version_info(modules, reserved)

        # Zigzag data placement order, mask parity folded in per position.
        positions: list[tuple[int, int]] = []
        upward = True
        col = size - 1
        while col >= 1:
            if col == 6:  # the vertical timing pattern is not a data column
                col -= 1
            for i in range(size):
                row = (size - 1 - i) if upward else i
                for c in (col, col - 1):
                    idx = row * size + c
                    if not reserved[idx]:
                        positions.append((idx, 1 if ((row // 2) + (c // 3)) % 2 == 0 else 0))
            upward = not upward
            col -= 2

        # The trailing remainder bits (0, 3, 4 or 7 of them) are always data 0,
        # so they are just their own mask bit and can be baked into the base.
        data_bits = 8 * self.total_codewords
        for idx, mask_bit in positions[data_bits:]:
            modules[idx] = mask_bit
        self.positions = positions[:data_bits]
        self.base = modules

    # -- function patterns --

    def _draw_function_patterns(self, m: bytearray, r: bytearray) -> None:
        size = self.size

        def set_module(x: int, y: int, dark: int) -> None:
            m[y * size + x] = dark
            r[y * size + x] = 1

        # Timing patterns
        for i in range(size):
            set_module(6, i, 1 - i % 2)
            set_module(i, 6, 1 - i % 2)

        # Finders, with their separators, at three corners
        for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < size and 0 <= y < size:
                        d = max(abs(dx), abs(dy))
                        set_module(x, y, 1 if d != 2 and d != 4 else 0)

        # Alignment patterns, skipping the three that collide with finders
        centres = alignment_positions(self.version)
        last = len(centres) - 1
        for i, cy in enumerate(centres):
            for j, cx in enumerate(centres):
                if (i, j) in ((0, 0), (0, last), (last, 0)):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        set_module(cx + dx, cy + dy, 1 if max(abs(dx), abs(dy)) != 1 else 0)

        # The dark module, and the reserved format-info strips
        set_module(8, size - 8, 1)
        for i in range(9):
            r[8 * size + i] = 1
            r[i * size + 8] = 1
        for i in range(8):
            r[8 * size + (size - 1 - i)] = 1
            r[(size - 1 - i) * size + 8] = 1

    def _draw_format_info(self, m: bytearray, r: bytearray) -> None:
        size = self.size
        bits = _FORMAT_BITS[self.ecl]
        get = lambda i: (bits >> i) & 1  # noqa: E731

        # First copy, around the top-left finder.
        for i in range(6):
            m[i * size + 8] = get(i)
        m[7 * size + 8] = get(6)
        m[8 * size + 8] = get(7)
        m[8 * size + 7] = get(8)
        for i in range(9, 15):
            m[8 * size + (14 - i)] = get(i)

        # Second copy, split between the other two finders.
        for i in range(8):
            m[8 * size + (size - 1 - i)] = get(i)
        for i in range(8, 15):
            m[(size - 15 + i) * size + 8] = get(i)
        m[(size - 8) * size + 8] = 1  # the dark module, again
        r[(size - 8) * size + 8] = 1

    def _draw_version_info(self, m: bytearray, r: bytearray) -> None:
        if self.version < 7:
            return
        size = self.size
        bits = _bch(self.version, 0x1F25, 12)
        for i in range(18):
            bit = (bits >> i) & 1
            a, b = size - 11 + i % 3, i // 3
            m[b * size + a] = bit
            r[b * size + a] = 1
            m[a * size + b] = bit
            r[a * size + b] = 1

    # -- per-frame encode --

    def encode(self, payload: bytes) -> bytearray:
        """Render `payload` into a module matrix (flat, row-major, 1 = dark)."""
        if len(payload) > self.capacity:
            raise ValueError(
                f"{len(payload)} bytes will not fit a V{self.version} "
                f"ECC {self.ecl} code (capacity {self.capacity})"
            )
        codewords = self._codewords(payload)
        modules = bytearray(self.base)
        i = 0
        positions = self.positions
        for byte in codewords:
            for shift in (7, 6, 5, 4, 3, 2, 1, 0):
                idx, mask_bit = positions[i]
                modules[idx] = ((byte >> shift) & 1) ^ mask_bit
                i += 1
        return modules

    def _codewords(self, payload: bytes) -> bytearray:
        count_bits = 8 if self.version <= 9 else 16
        # Mode indicator (0100) + character count + the bytes themselves.
        # With a 4-bit mode and an 8- or 16-bit count, everything lands on a
        # nibble boundary, so this is a nibble shuffle rather than a bit stream.
        header = bytearray()
        if count_bits == 8:
            header.append(0x40 | (len(payload) >> 4))
            header.append((len(payload) << 4) & 0xF0)
        else:
            header.append(0x40 | (len(payload) >> 12))
            header.append((len(payload) >> 4) & 0xFF)
            header.append((len(payload) << 4) & 0xF0)

        data = bytearray(header)
        carry = data[-1]
        del data[-1]
        for byte in payload:
            data.append(carry | (byte >> 4))
            carry = (byte << 4) & 0xF0
        # The terminator is four zero bits, which is exactly the low nibble
        # already sitting in `carry`.
        data.append(carry)

        # Pad to capacity with the specified alternating bytes.
        pad = (0xEC, 0x11)
        n = 0
        while len(data) < self.data_codewords:
            data.append(pad[n & 1])
            n += 1

        # Split into blocks, Reed-Solomon each, then interleave column-wise.
        num_blocks = self.num_blocks
        short_len = self.data_codewords // num_blocks
        num_long = self.data_codewords % num_blocks
        blocks = []
        eccs = []
        offset = 0
        for i in range(num_blocks):
            length = short_len + (1 if i >= num_blocks - num_long else 0)
            block = bytes(data[offset : offset + length])
            offset += length
            blocks.append(block)
            eccs.append(_rs_remainder(block, self._gen_logs))

        out = bytearray()
        for i in range(short_len + 1):
            for j, block in enumerate(blocks):
                # Short blocks have no column here; long ones do.
                if i < len(block):
                    out.append(block[i])
        for i in range(self.ecc_per_block):
            for ecc in eccs:
                out.append(ecc[i])
        return out


def smallest_version_for(payload_bytes: int, ecl: str, max_version: int = MAX_VERSION) -> int | None:
    for version in range(MIN_VERSION, max_version + 1):
        if byte_capacity(version, ecl) >= payload_bytes:
            return version
    return None


# =============================================================================
# Terminal rendering
# =============================================================================

# Half-block rendering: one column per module horizontally, two module-rows per
# text row. A character cell is about twice as tall as it is wide, so this
# gives square modules AND twice the density of the "two spaces per module"
# approach — on a 200x60 terminal that is the difference between a V23 code and
# a V11 one, which is 3.5x the throughput.
_GLYPHS = {0: " ", 1: "▄", 2: "▀", 3: "█"}
_DOUBLE = bytes(2 if i & 1 else 0 for i in range(256))
QUIET_ZONE = 4
# Rows kept clear below the code for the status line.
RESERVED_ROWS = 3

# The QR itself is not the only thing a decoder has to see: it needs the quiet
# zone to be light too. Filling it with the terminal's own background instead
# puts a black frame around a white code on any dark theme, and zxing's finder
# search copes badly with that.
_TRUECOLOR = "\x1b[38;2;0;0;0;48;2;255;255;255m"
_TRUECOLOR_INV = "\x1b[38;2;255;255;255;48;2;0;0;0m"
_256 = "\x1b[38;5;16;48;5;231m"
_256_INV = "\x1b[38;5;231;48;5;16m"
_BASIC = "\x1b[30;47m"
_BASIC_INV = "\x1b[37;40m"
_RESET = "\x1b[0m"

# Background-only fills, as (light, dark). A space has no glyph, and a terminal
# paints the whole cell rect with the background colour before it draws
# anything into it — so these tile exactly, on any font, at any line height.
# That is the entire point: the half-blocks above are at the mercy of whether
# the terminal synthesises U+2580/U+2584 itself (Windows Terminal, iTerm2,
# kitty, WezTerm, Ghostty all do) or renders them as font outlines and leaves a
# seam between every pair of module rows (Terminal.app).
_BG_TRUECOLOR = ("\x1b[48;2;255;255;255m", "\x1b[48;2;0;0;0m")
_BG_256 = ("\x1b[48;5;231m", "\x1b[48;5;16m")
_BG_BASIC = ("\x1b[47m", "\x1b[40m")

ALT_SCREEN_ON = "\x1b[?1049h"
ALT_SCREEN_OFF = "\x1b[?1049l"
CURSOR_HIDE = "\x1b[?25l"
CURSOR_SHOW = "\x1b[?25h"
CURSOR_HOME = "\x1b[H"


def color_support() -> str:
    """'truecolor', '256' or 'basic'."""
    if os.environ.get("COLORTERM", "") in ("truecolor", "24bit"):
        return "truecolor"
    if "256color" in os.environ.get("TERM", ""):
        return "256"
    return "basic"


def terminal_name() -> str:
    for var in ("TERM_PROGRAM", "TERMINAL_EMULATOR"):
        if os.environ.get(var):
            return os.environ[var]
    return os.environ.get("TERM", "unknown")


def half_blocks_tile() -> bool:
    """Whether this terminal draws U+2580/U+2584 as exact half-cell fills.

    Most modern terminals synthesise the block elements themselves, so the
    glyphs tile perfectly whatever the font. Terminal.app renders them as font
    outlines instead: they are antialiased, they do not span the line height,
    and every pair of module rows ends up separated by a hairline of
    background. The code still *looks* fine to a human and still fails to
    decode, which is the worst way for this to go wrong — so it is detected
    rather than left for the user to discover.
    """
    return os.environ.get("TERM_PROGRAM", "") != "Apple_Terminal"


def utf8_capable() -> bool:
    encoding = (sys.stdout.encoding or "").lower()
    if encoding.replace("-", "") in ("utf8", "utf_8"):
        return True
    for var in ("LC_ALL", "LC_CTYPE", "LANG"):
        if "utf" in os.environ.get(var, "").lower():
            return True
    return False


class Terminal:
    """The tty, its geometry, and everything that has to be put back."""

    def __init__(self) -> None:
        # /dev/tty, not stdin: under `curl ... | bash` stdin is the script
        # itself, and reading a byte of it would truncate the shell's own
        # source. This is also why nothing here ever touches sys.stdin.
        self.fd: int | None = None
        try:
            self.fd = os.open("/dev/tty", os.O_RDWR)
        except OSError:
            self.fd = None
        self.out = self.fd if self.fd is not None else 1
        self._saved_termios = None
        self._entered = False

    # -- geometry --

    def size(self) -> tuple[int, int]:
        try:
            size = os.get_terminal_size(self.out)
            if size.columns > 0 and size.lines > 0:
                return size.columns, size.lines
        except OSError:
            pass
        return (
            int(os.environ.get("COLUMNS", 80)),
            int(os.environ.get("LINES", 24)),
        )

    # -- screen state --

    def enter(self) -> None:
        if self._entered:
            return
        self._entered = True
        atexit.register(self.restore)
        # The preflight went out through print(), which is block-buffered when
        # stdout is a pipe or a file — while everything below writes with
        # os.write and bypasses that buffer. Without this flush, a redirected
        # run emits the whole stream first and the summary last.
        try:
            sys.stdout.flush()
        except (BrokenPipeError, ValueError):
            pass
        self.write(ALT_SCREEN_ON + CURSOR_HIDE)
        if self.fd is not None:
            try:
                import termios
                import tty

                self._saved_termios = termios.tcgetattr(self.fd)
                tty.setcbreak(self.fd)
            except Exception:
                # No termios (an odd tty, a CI runner): keys stop working and
                # ctrl-c still does. Not worth failing over.
                self._saved_termios = None

    def restore(self) -> None:
        if not self._entered:
            return
        self._entered = False
        if self._saved_termios is not None and self.fd is not None:
            try:
                import termios

                termios.tcsetattr(self.fd, termios.TCSADRAIN, self._saved_termios)
            except Exception:
                pass
            self._saved_termios = None
        # Leaving a terminal in raw mode with a hidden cursor and a white
        # background is genuinely hostile, so this runs from both a finally
        # block and atexit.
        self.write(_RESET + CURSOR_SHOW + ALT_SCREEN_OFF)

    # -- io --

    def write(self, text: str) -> None:
        try:
            # Encode explicitly rather than going through print: under LANG=C
            # sys.stdout is ASCII and the half-blocks raise UnicodeEncodeError
            # mid-frame.
            os.write(self.out, text.encode("utf-8", errors="replace"))
        except (BrokenPipeError, OSError):
            pass

    def read_key(self, timeout: float) -> str | None:
        """Wait up to `timeout` seconds for a keypress. Doubles as the sleep."""
        if self.fd is None:
            if timeout > 0:
                time.sleep(timeout)
            return None
        try:
            ready, _, _ = select.select([self.fd], [], [], max(0.0, timeout))
        except (OSError, ValueError):
            return None
        if not ready:
            return None
        try:
            data = os.read(self.fd, 8)
        except OSError:
            return None
        return data.decode("utf-8", errors="replace") if data else None


class Renderer:
    """Turns a module matrix into one string per frame, ready to write."""

    def __init__(self, half_blocks: bool = True, invert: bool = False,
                 color: bool = True, columns: int = 80):
        self.half_blocks = half_blocks
        self.columns = columns
        support = color_support()
        if not color:
            self.on, self.off = "", ""
        elif support == "truecolor":
            self.on = _TRUECOLOR_INV if invert else _TRUECOLOR
            self.off = _RESET
        elif support == "256":
            self.on = _256_INV if invert else _256
            self.off = _RESET
        else:
            self.on = _BASIC_INV if invert else _BASIC
            self.off = _RESET
        light, dark = {"truecolor": _BG_TRUECOLOR, "256": _BG_256}.get(support, _BG_BASIC)
        self.bg_light, self.bg_dark = (dark, light) if invert else (light, dark)
        # Background fills need colour. Without it the only thing left to carry
        # a module is the glyph itself, which is the ASCII path below.
        self.bg_fill = not half_blocks and color

    def cells(self, modules_per_side: int) -> tuple[int, int]:
        """(columns, rows) the rendered code occupies."""
        total = modules_per_side + 2 * QUIET_ZONE
        if self.half_blocks:
            return total, -(-total // 2)
        return total * 2, total

    def render(self, modules: bytearray, size: int) -> list[str]:
        total = size + 2 * QUIET_ZONE
        blank = bytes(total)
        rows: list[bytes] = [blank] * QUIET_ZONE
        for y in range(size):
            row = bytearray(total)
            row[QUIET_ZONE : QUIET_ZONE + size] = modules[y * size : (y + 1) * size]
            rows.append(bytes(row))
        rows.extend([blank] * QUIET_ZONE)

        pad = " " * max(0, (self.columns - self.cells(size)[0]) // 2)
        out: list[str] = []
        if self.half_blocks:
            if len(rows) % 2:
                rows.append(blank)
            for i in range(0, len(rows), 2):
                top, bottom = rows[i], rows[i + 1]
                # Both translate calls and the map run in C; this is why a
                # frame renders in well under a millisecond.
                codes = bytes(map(int.__or__, top.translate(_DOUBLE), bottom))
                text = codes.decode("latin-1").translate(_GLYPHS)
                out.append(f"{pad}{self.on}{text}{self.off}")
        elif self.bg_fill:
            # Two spaces per module, drawn entirely in background colour. Half
            # the density of the half-blocks, and worth it wherever the glyphs
            # cannot be trusted: nothing here depends on a font at all.
            # Runs are coalesced because a colour change per module would be
            # ~12 bytes each, and the repaint cost is what caps the frame rate.
            for row in rows:
                parts = [pad]
                for value, run in groupby(row):
                    parts.append(self.bg_dark if value else self.bg_light)
                    parts.append("  " * len(list(run)))
                parts.append(_RESET)
                out.append("".join(parts))
        else:
            # No colour at all, so the glyph is the only thing left to carry a
            # module. ASCII-only, and it also survives a locale that cannot
            # encode the half-blocks.
            for row in rows:
                out.append(f"{pad}{''.join('  ' if not v else '##' for v in row)}")
        return out


# =============================================================================
# The stream
# =============================================================================


class Layout:
    """The QR geometry a given terminal and settings can actually carry."""

    __slots__ = ("version", "ecl", "modules", "frame_bytes", "block_len",
                 "cols", "rows", "term_cols", "term_rows")

    def __init__(self, version, ecl, renderer, term_cols, term_rows):
        self.version = version
        self.ecl = ecl
        self.modules = 4 * version + 17
        self.frame_bytes = byte_capacity(version, ecl)
        self.block_len = self.frame_bytes - HEADER_LEN
        self.cols, self.rows = renderer.cells(self.modules)
        self.term_cols = term_cols
        self.term_rows = term_rows

    @property
    def fits(self) -> bool:
        return self.cols <= self.term_cols and self.rows + RESERVED_ROWS <= self.term_rows


def choose_version(renderer: Renderer, term_cols: int, term_rows: int,
                   ecl: str, max_version: int) -> int:
    """Largest version whose rendered code fits, honouring the version cap."""
    best = None
    for version in range(MIN_VERSION, max_version + 1):
        if Layout(version, ecl, renderer, term_cols, term_rows).fits:
            best = version
        else:
            break
    if best is None:
        raise SystemExit(
            f"error: this terminal is {term_cols}x{term_rows}, which cannot hold even the\n"
            f"       smallest QR code ({Layout(1, ecl, renderer, term_cols, term_rows).cols}"
            f" columns x {Layout(1, ecl, renderer, term_cols, term_rows).rows + RESERVED_ROWS}"
            f" rows).\n"
            f"       Make the window bigger or the font smaller."
        )
    return best


def preflight(packed: Packed, layout: Layout, fps: float, is_text: bool,
              quiet: bool = False) -> int:
    """Print the summary and return k. Raises SystemExit if it cannot be sent."""
    k = max(1, -(-len(packed.container) // layout.block_len))
    if k > MAX_SOURCE_BLOCKS:
        # The ceiling is a property of the frame size, not the file size: `k`
        # is a u16 on the wire. Naming the terminal geometry is the point —
        # the lever here is the font size, not anything about the file.
        needed = -(-len(packed.container) // MAX_SOURCE_BLOCKS) + HEADER_LEN
        version = smallest_version_for(needed, layout.ecl) or MAX_VERSION
        cols = 4 * version + 17 + 2 * QUIET_ZONE
        raise SystemExit(
            f"error: {human_bytes(packed.original_size)} needs {k:,} blocks at "
            f"{layout.block_len} bytes a frame,\n"
            f"       and a frame can only number {MAX_SOURCE_BLOCKS:,}.\n"
            f"       You need at least a V{version} code: {cols} columns x "
            f"{-(-(cols) // 2) + RESERVED_ROWS} rows.\n"
            f"       Shrink the font, or send a smaller file."
        )

    if quiet:
        return k

    payload_per_second = fps * layout.block_len / expected_overhead(k)
    best = k / fps
    typical = k * expected_overhead(k) / fps

    def line(key: str, value: str, note: str = "") -> None:
        print(f"  {key:<11} {value:<21} {note}".rstrip())

    print()
    line("send", packed.name, f"{human_bytes(packed.original_size)}   {packed.media_type}")
    if packed.compression == "gzip":
        saved = 100 - packed.transmitted_size * 100 // max(1, packed.original_size)
        line("compress", "gzip", f"{human_bytes(packed.transmitted_size)}   (-{saved}%)")
    else:
        line("compress", "none", "")
    line("terminal", f"{layout.term_cols} x {layout.term_rows}",
         f"{terminal_name()}, {color_support()}")
    line("qr", f"V{layout.version}  ECC {layout.ecl}  mask {MASK_PATTERN}",
         f"{layout.modules} modules -> {layout.cols} cols x {layout.rows} rows")
    line("frame", f"{layout.frame_bytes} bytes",
         f"{layout.block_len} payload + {HEADER_LEN} header")
    line("fountain", f"k = {k:,} blocks", "")
    line("rate", f"{fps:g} fps", f"{payload_per_second / 1024:.1f} KB/s")
    # Both numbers, deliberately. k/fps is a time this transfer will never
    # actually achieve, and quoting it alone makes the tool look like it is
    # lying once the bar passes it.
    line("one pass", f"best  {human_duration(best)}", f"{k:,} frames")
    line("", f"typical {human_duration(typical)}",
         f"{math.ceil(k * expected_overhead(k)):,} frames  (k x "
         f"{expected_overhead(k):.2f})")
    print()
    line("receiver", RECEIVER_URL, "")
    print()
    if is_text:
        print("  Text is sent as a snippet — the receiver shows it, with a copy button.")
    print("  It loops forever. Stop it yourself (q or ctrl-c) once the receiver says")
    print("  the transfer is verified — the sender has no way to know.")
    print()
    return k


def stream(packed: Packed, layout: Layout, term: Terminal, renderer: Renderer,
           fps: float, session_id: int, max_frames: int | None,
           allow_resize: bool, version_cap: int) -> str:
    """Draw frames until stopped.

    Returns "quit" when the user stopped it or the frame budget ran out, and
    "resize" when the terminal changed size enough to need a new QR version —
    the caller restarts the stream with a fresh session.
    """
    payload = packed.container
    encoder = LTEncoder(payload, layout.block_len, session_id)
    payload_fnv = fnv1a(payload)
    template = QrTemplate(layout.version, layout.ecl)

    seq = 0
    frames = 0
    paused = False
    started = time.monotonic()
    period = 1.0 / fps
    deadline = time.monotonic()
    resize_pending = 0.0

    if allow_resize and hasattr(signal, "SIGWINCH"):
        def on_winch(_signum, _frame):
            nonlocal resize_pending
            resize_pending = time.monotonic()
        signal.signal(signal.SIGWINCH, on_winch)

    term.enter()
    try:
        while True:
            if not paused:
                frame = pack_frame(
                    session_id, seq, encoder.k, encoder.block_len,
                    len(payload), payload_fnv, encoder.encode(seq),
                )
                modules = template.encode(frame)
                seq = (seq + 1) & U32
                frames += 1

                elapsed = time.monotonic() - started
                passes = frames / encoder.k
                status = (
                    f"seq {frames:,} · {human_duration(elapsed)} · {passes:.2f} passes · "
                    f"V{layout.version} {layout.ecl} {fps:g}fps · "
                    f"[q] stop  [space] pause  [+/-] fps"
                )
                body = "\r\n".join(renderer.render(modules, template.size))
                # One write per frame. Several would let the emulator paint a
                # partial code, and the camera would capture a torn frame.
                # Also: never a trailing newline, and never the bottom-right
                # cell — either scrolls the screen and desyncs every redraw
                # after it.
                term.write(f"{CURSOR_HOME}{body}\r\n\r\n  {status[: layout.term_cols - 3]}\x1b[K")

                if max_frames is not None and frames >= max_frames:
                    return "quit"

            deadline += period
            slack = deadline - time.monotonic()
            key = term.read_key(max(0.0, slack))
            if slack < -3 * period:
                # Genuinely behind (a stall, a slow emulator). Resync rather
                # than firing a burst of frames no camera can resolve.
                deadline = time.monotonic() + period

            if key:
                if key in ("q", "\x1b", "\x03"):
                    return "quit"
                if key == " ":
                    paused = not paused
                elif key in ("+", "="):
                    fps = min(60.0, fps + 1)
                    period = 1.0 / fps
                elif key in ("-", "_"):
                    fps = max(1.0, fps - 1)
                    period = 1.0 / fps

            if resize_pending and time.monotonic() - resize_pending > 0.25:
                resize_pending = 0.0
                cols, rows = term.size()
                renderer.columns = cols
                new_version = choose_version(renderer, cols, rows, layout.ecl, version_cap)
                if new_version != layout.version:
                    # A different version means a different block length, hence
                    # a different stream identity — the receiver resets no
                    # matter what we do, so make it a clean restart.
                    return "resize"
                term.write("\x1b[2J")
    finally:
        term.restore()


# =============================================================================
# Command line
# =============================================================================

EPILOG = f"""
examples:
  qr report.pdf                 send a file at the defaults
  qr --text "wifi password"     send a text snippet
  qr photo.jpg --fps 8          slow it down for a fussy camera
  qr big.tar --dense            use the whole terminal (up to V40)
  qr --selftest                 check your terminal and camera in 10 seconds

receiving:
  Open {RECEIVER_URL} on the other device
  and point its camera at this terminal.

making it readable:
  The code is drawn one module per character cell, so its physical size is
  your font size. Bigger font, bigger code; smaller font, more data per frame.

  Terminal profiles with background transparency, a background image, or
  window blur BREAK decoding outright — the camera sees your wallpaper mixed
  into the code. So does "dim" or "faint" text rendering. Use an opaque
  profile.

  The dense mode packs two module rows into each text row using the half-block
  characters, which only works if your terminal fills the cell with them.
  Terminal.app does not — it draws them from the font and leaves seams — so it
  gets --render full automatically. That mode paints every module as a
  background colour behind a space, so it depends on no font at all.

  A module has to stay square, so --render full spends two cells across and one
  down where the dense mode spends one across and half a one down: 4x the cells
  for the same code. Halve your font size and you get the identical physical
  code back, because a module's size on screen is what the camera sees, not the
  number of cells drawing it.

this is not encrypted:
  Whatever is on this screen is readable by any camera pointed at it. The
  property you get is no network, not confidentiality.
"""


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="qr",
        description="Stream a file as animated, fountain-coded QR codes in this terminal.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("file", nargs="?", help="the file to send")
    p.add_argument("--text", metavar="TEXT", help="send a text snippet instead of a file")
    p.add_argument("--text-file", metavar="PATH",
                   help="send a file's contents as a text snippet")
    p.add_argument("--no-gzip", action="store_true",
                   help="never compress, even when it would help")

    p.add_argument("--fps", type=float, default=12.0, metavar="N",
                   help="frames per second (default: 12)")
    p.add_argument("--bytes", type=int, metavar="N", dest="frame_bytes",
                   help="force the frame size in bytes (payload + 20 header)")
    p.add_argument("--ecc", choices=ECC_LEVELS, default="L",
                   help="QR error correction level (default: L)")
    p.add_argument("--max-version", type=int, default=27, metavar="N",
                   help="largest QR version to use (default: 27)")
    p.add_argument("--dense", action="store_true",
                   help="shorthand for --max-version 40")
    p.add_argument("--max-cols", type=int, metavar="N", help="cap the code's width")
    p.add_argument("--max-rows", type=int, metavar="N", help="cap the code's height")

    p.add_argument("--render", choices=("half", "full"), default=None,
                   help="half-block (dense) or two-column colour fill "
                        "(default: half, except where the terminal is known "
                        "to draw the half-blocks with seams)")
    p.add_argument("--invert", action="store_true", help="light modules on dark")
    p.add_argument("--no-color", action="store_true",
                   help="use the terminal's own colours (usually undecodable)")
    p.add_argument("--no-resize", action="store_true",
                   help="pin the QR version instead of restarting on a resize")
    p.add_argument("--no-caffeinate", action="store_true",
                   help="allow the display to sleep during the transfer")

    p.add_argument("--frames", type=int, metavar="N", help="stop after N frames")
    p.add_argument("--passes", type=float, metavar="N",
                   help="stop after N x k x 1.15 frames")
    p.add_argument("--session", type=int, metavar="ID",
                   help="fixed session id, for reproducible streams")

    p.add_argument("--selftest", action="store_true",
                   help="stream a short known snippet, to check the setup")
    p.add_argument("--dump-frames", metavar="DIR",
                   help="write raw frame bytes to DIR instead of drawing (testing)")
    p.add_argument("--json", action="store_true",
                   help="print the preflight as JSON and exit")
    p.add_argument("--quiet", action="store_true", help="skip the preflight summary")
    p.add_argument("--version", action="version", version=f"qrsend {VERSION}")
    return p


def load_payload(args) -> tuple[Packed, bool]:
    """Returns (packed, is_text)."""
    if args.selftest:
        text = (
            "flight selftest — if you can read this on the other device, your "
            "terminal, font and camera are all good.\n"
        )
        return pack_file(SNIPPET_FILE_NAME, SNIPPET_MEDIA_TYPE,
                         text.encode("utf-8"), allow_gzip=False), True

    if args.text is not None:
        data = args.text.encode("utf-8")
        if not args.text.strip():
            raise SystemExit("error: --text is empty.")
        return pack_file(SNIPPET_FILE_NAME, SNIPPET_MEDIA_TYPE, data,
                         allow_gzip=not args.no_gzip), True

    if args.text_file:
        data = read_file(args.text_file)
        return pack_file(SNIPPET_FILE_NAME, SNIPPET_MEDIA_TYPE, data,
                         allow_gzip=not args.no_gzip), True

    if not args.file:
        raise SystemExit("error: no file given. Try `qr myfile.pdf`, or `qr --help`.")
    if args.file == "-":
        # Under `curl ... | bash -s -- -`, stdin is the bootstrap script.
        # Reading it would consume the shell's own source mid-parse.
        raise SystemExit("error: reading from stdin is not supported — pass a path.")
    data = read_file(args.file)
    return pack_file(os.path.basename(args.file), guess_media_type(args.file), data,
                     allow_gzip=not args.no_gzip), False


def read_file(path: str) -> bytes:
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except IsADirectoryError:
        raise SystemExit(f"error: {path} is a directory. Archive it first.") from None
    except FileNotFoundError:
        raise SystemExit(f"error: {path} does not exist.") from None
    except PermissionError:
        raise SystemExit(f"error: {path} is not readable.") from None


def dump_frames(packed: Packed, block_len: int, session_id: int,
                count: int, directory: str) -> None:
    """Write raw frames for the loopback test to feed to the real decoder."""
    os.makedirs(directory, exist_ok=True)
    encoder = LTEncoder(packed.container, block_len, session_id)
    payload_fnv = fnv1a(packed.container)
    for seq in range(count):
        frame = pack_frame(session_id, seq, encoder.k, block_len,
                           len(packed.container), payload_fnv, encoder.encode(seq))
        with open(os.path.join(directory, f"{seq:06d}.bin"), "wb") as handle:
            handle.write(frame)
    with open(os.path.join(directory, "meta.json"), "w") as handle:
        import json
        json.dump({
            "sessionId": session_id, "k": encoder.k, "blockLen": block_len,
            "totalLen": len(packed.container), "payloadFnv": payload_fnv,
            "frames": count, "name": packed.name, "mediaType": packed.media_type,
            "compression": packed.compression, "originalSize": packed.original_size,
        }, handle)


def keep_display_awake() -> subprocess.Popen | None:
    """Best effort, and genuinely optional — a 10-minute transfer should not
    be ended by a screensaver, but failing to prevent one is not an error."""
    try:
        if sys.platform == "darwin":
            return subprocess.Popen(
                ["caffeinate", "-dimsu", "-w", str(os.getpid())],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        return None
    except (OSError, ValueError):
        return None


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.dense:
        args.max_version = MAX_VERSION
    args.max_version = max(MIN_VERSION, min(MAX_VERSION, args.max_version))
    if args.fps <= 0:
        raise SystemExit("error: --fps must be positive.")

    try:
        packed, is_text = load_payload(args)
    except ValueError as err:
        # pack_file rejects empty and oversized payloads with a ValueError.
        # Those are user errors, not bugs, and a traceback reads as a crash.
        raise SystemExit(f"error: {err}") from None
    session_id = (args.session if args.session is not None
                  else (int.from_bytes(os.urandom(2), "big") % 0xFFFF) + 1) & 0xFFFF

    term = Terminal()
    term_cols, term_rows = term.size()
    if args.max_cols:
        term_cols = min(term_cols, args.max_cols)
    if args.max_rows:
        term_rows = min(term_rows, args.max_rows)

    half = args.render != "full"
    if half and not utf8_capable():
        # The half-blocks cannot be encoded at all under a non-UTF-8 locale,
        # and a UnicodeEncodeError three frames in is a worse outcome than
        # quietly using the format that works.
        half = False
        if not args.quiet:
            print("note: this locale is not UTF-8, so --render full is being used.",
                  file=sys.stderr)
    elif half and args.render is None and not half_blocks_tile():
        # Not a preference — on these terminals the half-blocks simply do not
        # decode, so defaulting to a dense code that cannot be read is the
        # wrong trade. Explicit --render half still wins, because a different
        # font or line height may well tile fine.
        half = False
        if not args.quiet:
            print(f"note: {terminal_name()} draws the half-block characters from the font "
                  "rather than\n"
                  "      filling the cell, so every pair of module rows is separated by a\n"
                  "      seam a decoder cannot read through. Using --render full.\n"
                  "      It spends 4x the character cells on the same code, so HALVE YOUR\n"
                  "      FONT SIZE to get the same physical code back. Or use a terminal\n"
                  "      that draws the block characters itself (iTerm2, Ghostty, kitty,\n"
                  "      WezTerm) and pass --render half.",
                  file=sys.stderr)
    renderer = Renderer(half_blocks=half, invert=args.invert,
                        color=not args.no_color, columns=term_cols)

    # --dump-frames and --json never draw anything, so the terminal's size is
    # not a constraint on them — refusing to dump frames into a file because
    # the window is small would be nonsense, and it is exactly what a CI runner
    # (80x24, no tty) would hit.
    drawing = not (args.dump_frames or args.json)

    if args.frame_bytes:
        # --bytes names the whole frame, header included, which is exactly
        # what a QR byte-mode segment has to carry.
        version = smallest_version_for(args.frame_bytes, args.ecc, MAX_VERSION)
        if version is None:
            raise SystemExit(
                f"error: {args.frame_bytes} bytes exceeds the largest QR code "
                f"({byte_capacity(MAX_VERSION, args.ecc)} bytes at ECC {args.ecc})."
            )
        layout = Layout(version, args.ecc, renderer, term_cols, term_rows)
        if drawing and not layout.fits:
            # Never degrade quietly: a code that wraps or clips is not a
            # smaller code, it is an undecodable one.
            fitting = choose_version(renderer, term_cols, term_rows, args.ecc, MAX_VERSION)
            raise SystemExit(
                f"error: {args.frame_bytes} bytes needs a V{version} code: "
                f"{layout.cols} columns x {layout.rows + RESERVED_ROWS} rows.\n"
                f"       This terminal is {term_cols} x {term_rows}. Shrink the font, "
                f"or use --bytes {byte_capacity(fitting, args.ecc)} (V{fitting}, fits)."
            )
    elif drawing:
        version = choose_version(renderer, term_cols, term_rows, args.ecc, args.max_version)
        layout = Layout(version, args.ecc, renderer, term_cols, term_rows)
    else:
        layout = Layout(args.max_version, args.ecc, renderer, term_cols, term_rows)

    if args.dump_frames:
        k = max(1, -(-len(packed.container) // layout.block_len))
        count = args.frames or math.ceil(k * 2)
        dump_frames(packed, layout.block_len, session_id, count, args.dump_frames)
        print(f"wrote {count} frames to {args.dump_frames}")
        return 0

    if args.json:
        import json
        k = max(1, -(-len(packed.container) // layout.block_len))
        print(json.dumps({
            "name": packed.name, "mediaType": packed.media_type,
            "originalSize": packed.original_size,
            "transmittedSize": packed.transmitted_size,
            "compression": packed.compression, "containerLength": len(packed.container),
            "version": layout.version, "ecc": layout.ecl, "mask": MASK_PATTERN,
            "modules": layout.modules, "cols": layout.cols, "rows": layout.rows,
            "frameBytes": layout.frame_bytes, "blockLen": layout.block_len,
            "k": k, "fps": args.fps, "sessionId": session_id,
            "expectedOverhead": expected_overhead(k),
            "terminal": {"cols": term_cols, "rows": term_rows,
                         "color": color_support(), "name": terminal_name()},
        }, indent=2))
        return 0

    k = preflight(packed, layout, args.fps, is_text, quiet=args.quiet)

    if os.environ.get("TMUX"):
        print("note: tmux adds a repaint layer — expect roughly half the frame rate.")
    if os.environ.get("SSH_CONNECTION"):
        print("note: over ssh, each frame is several KB of terminal output. "
              "Lower --fps if it stutters.")

    max_frames = args.frames
    if args.passes:
        max_frames = math.ceil(k * expected_overhead(k) * args.passes)

    awake = None if args.no_caffeinate else keep_display_awake()
    try:
        while True:
            outcome = stream(packed, layout, term, renderer, args.fps, session_id,
                             max_frames, not args.no_resize, args.max_version)
            if outcome != "resize":
                break
            term_cols, term_rows = term.size()
            renderer.columns = term_cols
            version = choose_version(renderer, term_cols, term_rows,
                                     args.ecc, args.max_version)
            layout = Layout(version, args.ecc, renderer, term_cols, term_rows)
            # A new session, deliberately: the receiver's decoder is reset by
            # the geometry change regardless, and a fresh id makes that
            # unambiguous rather than relying on a 16-bit id not colliding.
            session_id = (int.from_bytes(os.urandom(2), "big") % 0xFFFF) + 1
            print(f"resized — restarting at V{version} "
                  f"({layout.frame_bytes} bytes/frame). Receiver progress is lost.")
    except KeyboardInterrupt:
        pass
    finally:
        term.restore()
        if awake is not None:
            awake.terminate()
    print("stopped.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.exit(0)
