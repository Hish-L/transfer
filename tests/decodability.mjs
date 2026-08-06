// Do the Python encoder's QR codes actually read?
//
// Matching node-qrcode's module matrix (tests/test_qr.py) proves the encoder
// agrees with another encoder. It does not prove a decoder agrees with either
// of them — a botched format-info BCH, for instance, produces a matrix that is
// self-consistent and universally unreadable. So: render to a bitmap and run
// the receiver's own zxing build over it.
//
//   node --import tsx tests/decodability.mjs

import { execFileSync } from "node:child_process";
import { readBarcodes } from "zxing-wasm/reader";
import { parseFrame } from "../shared/protocol.ts";

const PYTHON = process.env.QRTRANSFER_PYTHON ?? "python3";
const SENDER = new URL("../cli/qrsend.py", import.meta.url).pathname;
const SCALE = 4; // pixels per module — zxing wants a few to work with

let failures = 0;
let passes = 0;

/** Ask the Python encoder for a module matrix as a 0/1 string. */
function encode(version, ecl, payloadLength) {
  const script = `
import sys, os
sys.path.insert(0, ${JSON.stringify(new URL("../cli", import.meta.url).pathname)})
import qrsend
t = qrsend.QrTemplate(${version}, ${JSON.stringify(ecl)})
payload = bytes(((i * 37 + (i >> 8) * 11) & 0xFF) for i in range(${payloadLength}))
sys.stdout.write(str(t.size) + " " + "".join(str(v) for v in t.encode(payload)))
`;
  const out = execFileSync(PYTHON, ["-c", script], { encoding: "utf8" });
  const [size, modules] = out.split(" ");
  return { size: Number(size), modules };
}

/** Modules -> ImageData, with the 4-module quiet zone the spec requires. */
function toImageData(size, modules) {
  const margin = 4;
  const side = (size + 2 * margin) * SCALE;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y * size + x] !== "1") continue;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const px = ((y + margin) * SCALE + dy) * side + (x + margin) * SCALE + dx;
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

async function checkFrame(label, version, ecl, payloadLength, expected) {
  const { size, modules } = encode(version, ecl, payloadLength);
  const results = await readBarcodes(toImageData(size, modules), {
    formats: ["QRCode"],
    maxNumberOfSymbols: 1,
  });
  const hit = results.find((r) => r.isValid && r.bytes.length > 0);
  if (!hit) {
    failures++;
    console.error(`  FAIL ${label} — zxing found no readable code`);
    return null;
  }
  const bytes = Buffer.from(hit.bytes);
  if (expected && !bytes.equals(Buffer.from(expected))) {
    failures++;
    console.error(`  FAIL ${label} — decoded ${bytes.length} bytes, expected ${expected.length}`);
    return null;
  }
  passes++;
  console.log(`  ok   ${label} (${bytes.length} bytes)`);
  return bytes;
}

function payload(n) {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = (i * 37 + (i >> 8) * 11) & 0xff;
  return out;
}

console.log("decodability: python encoder -> zxing (the receiver's own decoder)\n");

// A spread of versions and every ECC level, at capacity and just under it.
// Capacity is the interesting end: that is where the pad codewords vanish and
// the block interleave is fully exercised.
for (const [version, ecl] of [
  [1, "L"], [1, "H"], [5, "M"], [10, "L"], [10, "Q"],
  [22, "L"], [27, "L"], [33, "M"], [40, "L"], [40, "H"],
]) {
  const script = execFileSync(
    PYTHON,
    ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(new URL("../cli", import.meta.url).pathname)});` +
      ` import qrsend; print(qrsend.byte_capacity(${version}, ${JSON.stringify(ecl)}))`],
    { encoding: "utf8" },
  );
  const capacity = Number(script.trim());
  await checkFrame(`V${version}-${ecl} at capacity (${capacity}B)`, version, ecl, capacity,
    payload(capacity));
  await checkFrame(`V${version}-${ecl} at 1 byte`, version, ecl, 1, payload(1));
}

// And a real frame off the wire: the exact bytes the receiver would parse.
{
  const framesDir = execFileSync(PYTHON, ["-c",
    "import tempfile; print(tempfile.mkdtemp())"], { encoding: "utf8" }).trim();
  execFileSync(PYTHON, [SENDER, "--text", "a real frame, end to end",
    "--dump-frames", framesDir, "--bytes", "1465"], { stdio: "pipe" });
  const { readFileSync } = await import("node:fs");
  const frame = readFileSync(`${framesDir}/000000.bin`);
  const { size, modules } = (() => {
    const script = `
import sys, base64
sys.path.insert(0, ${JSON.stringify(new URL("../cli", import.meta.url).pathname)})
import qrsend
t = qrsend.QrTemplate(27, "L")
data = base64.b64decode(${JSON.stringify(frame.toString("base64"))})
sys.stdout.write(str(t.size) + " " + "".join(str(v) for v in t.encode(data)))
`;
    const out = execFileSync(PYTHON, ["-c", script], { encoding: "utf8" });
    const [s, m] = out.split(" ");
    return { size: Number(s), modules: m };
  })();
  const results = await readBarcodes(toImageData(size, modules), {
    formats: ["QRCode"], maxNumberOfSymbols: 1,
  });
  const hit = results.find((r) => r.isValid && r.bytes.length > 0);
  const parsed = hit ? parseFrame(new Uint8Array(hit.bytes)) : null;
  if (parsed && Buffer.from(hit.bytes).equals(frame)) {
    passes++;
    console.log(`  ok   a real wire frame survives the round trip (k=${parsed.header.k})`);
  } else {
    failures++;
    console.error("  FAIL a real wire frame did not survive the round trip");
  }
}

// And the browser sender's own path, which nothing else covers: the exact
// QRCode.create call from send/main.ts, through rasterizeQr, back out of
// zxing and into parseFrame. A test that only checks the Python encoder would
// miss a broken byte-mode segment or a wrong quiet zone on the web side.
{
  const { default: QRCode } = await import("qrcode");
  const { LTEncoder } = await import("../shared/fountain.ts");
  const { fnv1a, packFrame } = await import("../shared/protocol.ts");
  const { rasterizeQr } = await import("../shared/qr-raster.ts");

  const container = payload(40000);
  const frameBytes = 1465;
  const sessionId = 4242;
  const encoder = new LTEncoder(container, frameBytes - 20, sessionId);
  const payloadFnv = fnv1a(container);

  let version;
  let bad = 0;
  for (let seq = 0; seq < 6; seq++) {
    const frame = packFrame(
      { sessionId, seq, k: encoder.k, blockLen: encoder.blockLen,
        totalLen: container.length, payloadFnv },
      encoder.encode(seq),
    );
    const qr = QRCode.create([{ data: frame, mode: "byte" }], {
      errorCorrectionLevel: "L", version, maskPattern: 4,
    });
    // The version must lock on the first frame: if it drifted, the code would
    // change physical size mid-stream and every camera would have to refind it.
    if (version === undefined) version = qr.version;
    else if (qr.version !== version) { bad++; continue; }

    const raster = rasterizeQr(qr.modules.size, qr.modules.data, 4);
    // Blow the 1px-per-module raster up the way the canvas does.
    const side = raster.size * SCALE;
    const data = new Uint8ClampedArray(side * side * 4).fill(255);
    for (let y = 0; y < raster.size; y++) {
      for (let x = 0; x < raster.size; x++) {
        if (raster.pixels[y * raster.size + x] !== 0xff000000) continue;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const px = (y * SCALE + dy) * side + x * SCALE + dx;
            data[px * 4] = 0; data[px * 4 + 1] = 0; data[px * 4 + 2] = 0;
          }
        }
      }
    }
    const results = await readBarcodes({ data, width: side, height: side },
      { formats: ["QRCode"], maxNumberOfSymbols: 1 });
    const hit = results.find((r) => r.isValid && r.bytes.length > 0);
    const parsed = hit ? parseFrame(new Uint8Array(hit.bytes)) : null;
    if (!parsed || !Buffer.from(hit.bytes).equals(Buffer.from(frame))) bad++;
  }

  if (bad === 0) {
    passes++;
    console.log(`  ok   the browser sender's frames read back (V${version}, 6 frames)`);
  } else {
    failures++;
    console.error(`  FAIL the browser sender's frames — ${bad} of 6 failed`);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
