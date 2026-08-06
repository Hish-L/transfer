// Dump node-qrcode's module matrices so the Python encoder can be checked
// against the library the browser sender actually uses.
//
// Every (version, level) pair, at three payload lengths each. That is what
// validates the two ISO Table 9 arrays embedded in qrsend.py: a single wrong
// cell changes the block split for exactly one version and level, which is
// invisible until someone sends a file at that size.
//
//   node tests/dump_qr.mjs > qr-vectors.json

import QRCode from "qrcode";

const LEVELS = ["L", "M", "Q", "H"];

/** Deterministic filler, so Python can regenerate the same payload from a length. */
function payload(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 37 + (i >> 8) * 11) & 0xff;
  return out;
}

const cases = [];
for (let version = 1; version <= 40; version++) {
  for (const ecl of LEVELS) {
    // Ask the library for this version's capacity by encoding at it and
    // reading back what fits — deriving it here from our own formula would
    // make the test agree with itself rather than with the library.
    let capacity = 0;
    for (let probe = 1; probe <= 3000; probe++) {
      try {
        QRCode.create([{ data: payload(probe), mode: "byte" }], {
          errorCorrectionLevel: ecl,
          version,
          maskPattern: 4,
        });
        capacity = probe;
      } catch {
        break;
      }
    }
    for (const length of new Set([1, Math.max(1, capacity - 1), capacity])) {
      const qr = QRCode.create([{ data: payload(length), mode: "byte" }], {
        errorCorrectionLevel: ecl,
        version,
        maskPattern: 4,
      });
      cases.push({
        version,
        ecl,
        capacity,
        length,
        size: qr.modules.size,
        // One hex digit per 4 modules would be fiddly to line up; a plain
        // 0/1 string is unambiguous and compresses fine in a JSON file.
        modules: Array.from(qr.modules.data, (v) => (v ? "1" : "0")).join(""),
      });
    }
  }
}

process.stdout.write(`${JSON.stringify({ cases })}\n`);
