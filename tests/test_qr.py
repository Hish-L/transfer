"""Assert the pure-Python QR encoder against node-qrcode.

Covers all 160 (version x ECC level) combinations at three payload lengths
each. That breadth is the point: the two ISO Table 9 arrays in qrsend.py are
the only data in this project that has to be transcribed by hand, and a single
wrong cell changes the block split for exactly one version and level. Nothing
short of sweeping the whole table finds that.

    node tests/dump_qr.mjs > tests/qr-vectors.json
    python3 tests/test_qr.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "cli"))

import qrsend  # noqa: E402

VECTORS_PATH = ROOT / "tests" / "qr-vectors.json"


def load_cases() -> list[dict]:
    if VECTORS_PATH.exists():
        return json.loads(VECTORS_PATH.read_text())["cases"]
    out = subprocess.run(
        ["node", str(ROOT / "tests" / "dump_qr.mjs")],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)["cases"]


CASES = load_cases()


def payload(n: int) -> bytes:
    return bytes(((i * 37 + (i >> 8) * 11) & 0xFF) for i in range(n))


class TestQrEncoder(unittest.TestCase):
    def test_matrices_match_node_qrcode(self):
        self.assertGreater(len(CASES), 400, "the vector dump looks truncated")
        templates: dict[tuple[int, str], qrsend.QrTemplate] = {}
        for case in CASES:
            key = (case["version"], case["ecl"])
            template = templates.get(key)
            if template is None:
                template = templates[key] = qrsend.QrTemplate(*key)
            modules = template.encode(payload(case["length"]))
            actual = "".join("1" if v else "0" for v in modules)
            self.assertEqual(
                template.size, case["size"],
                f"V{case['version']}-{case['ecl']} module count differs",
            )
            self.assertEqual(
                actual, case["modules"],
                f"V{case['version']}-{case['ecl']} at {case['length']} bytes differs",
            )

    def test_capacities_match_node_qrcode(self):
        # Independently of the matrices: our derived raw_data_modules and the
        # two ECC tables have to agree with the library on how much fits.
        for case in CASES:
            self.assertEqual(
                qrsend.byte_capacity(case["version"], case["ecl"]),
                case["capacity"],
                f"V{case['version']}-{case['ecl']} capacity differs",
            )

    def test_known_frame_sizes(self):
        # The frame sizes the browser sender offers are QR-L capacities. If
        # these drift, the two senders stop agreeing on what a "2953-byte
        # frame" even is.
        self.assertEqual(qrsend.byte_capacity(40, "L"), 2953)
        self.assertEqual(qrsend.byte_capacity(27, "L"), 1465)

    def test_oversized_payload_is_refused(self):
        template = qrsend.QrTemplate(5, "L")
        with self.assertRaises(ValueError):
            template.encode(payload(template.capacity + 1))

    def test_alignment_positions(self):
        # Spot values from ISO/IEC 18004 Annex E, including the version 32
        # case the general formula gets wrong.
        self.assertEqual(qrsend.alignment_positions(1), [])
        self.assertEqual(qrsend.alignment_positions(2), [6, 18])
        self.assertEqual(qrsend.alignment_positions(7), [6, 22, 38])
        self.assertEqual(qrsend.alignment_positions(32), [6, 34, 60, 86, 112, 138])
        self.assertEqual(qrsend.alignment_positions(40), [6, 30, 58, 86, 114, 142, 170])


if __name__ == "__main__":
    unittest.main(verbosity=2)
