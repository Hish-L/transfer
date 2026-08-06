// End-to-end: frames produced by the Python sender, decoded by the real
// browser decoder.
//
// This is the strongest test in the suite. It exercises the container, the
// frame header, the fountain, the byte order and the compression decision in
// one assertion, and it is the one that would actually catch a shipped bug —
// the unit-level parity vectors can all pass while the two ends still fail to
// agree on something nobody thought to pin.
//
//   node --import tsx tests/loopback.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LTDecoder } from "../shared/fountain.ts";
import { fnv1a, parseFrame, streamIdentity, unpackFile, verifyFile } from "../shared/protocol.ts";
import { isSnippet, snippetText } from "../shared/snippet.ts";

const PYTHON = process.env.QRTRANSFER_PYTHON ?? "python3";
const SENDER = new URL("../cli/qrsend.py", import.meta.url).pathname;

let failures = 0;
let passes = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Run the Python sender over `content`, then feed its frames to the real
 * decoder exactly as the receiver would — including the stream-identity gate
 * and all three integrity checks.
 */
async function roundTrip(name, fileName, content, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), "qrloop-"));
  const framesDir = join(dir, "frames");
  const inputPath = join(dir, fileName);
  writeFileSync(inputPath, content);

  try {
    execFileSync(
      PYTHON,
      [SENDER, inputPath, "--dump-frames", framesDir, "--bytes", "1465", ...extraArgs],
      { stdio: "pipe" },
    );

    const meta = JSON.parse(readFileSync(join(framesDir, "meta.json"), "utf8"));
    const files = readdirSync(framesDir).filter((f) => f.endsWith(".bin")).sort();

    let decoder;
    let key = "";
    let completed = null;
    for (const entry of files) {
      const bytes = new Uint8Array(readFileSync(join(framesDir, entry)));
      const parsed = parseFrame(bytes);
      if (!parsed) {
        check(`${name}: every frame parses`, false, `${entry} was rejected`);
        return;
      }
      const identity = streamIdentity(parsed.header);
      if (!decoder || key !== identity) {
        decoder = new LTDecoder(
          parsed.header.k, parsed.header.blockLen,
          parsed.header.sessionId, parsed.header.totalLen,
        );
        key = identity;
      }
      decoder.addFrame(parsed.header.seq, parsed.block);
      if (decoder.isComplete) {
        completed = decoder.assemble();
        break;
      }
    }

    check(`${name}: the fountain completed`, completed !== null,
      `${files.length} frames was not enough for k=${meta.k}`);
    if (!completed) return;

    // Exactly the receiver's sequence: FNV over the container, then unpack,
    // then SHA-256 — nothing is trusted before the last one passes.
    check(`${name}: container checksum`, fnv1a(completed) === meta.payloadFnv);
    const file = await unpackFile(completed);
    check(`${name}: SHA-256 verified`, await verifyFile(file));
    check(`${name}: filename preserved`, file.name === fileName,
      `got ${JSON.stringify(file.name)}`);
    check(`${name}: compression agreed`, file.compression === meta.compression,
      `python said ${meta.compression}, container says ${file.compression}`);
    check(`${name}: bytes are identical`,
      Buffer.from(file.bytes).equals(Buffer.from(content)));
    check(`${name}: overhead is sane`, decoder.framesNew / meta.k < 2.0,
      `needed ${(decoder.framesNew / meta.k).toFixed(2)}x k`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function snippetRoundTrip() {
  const dir = mkdtempSync(join(tmpdir(), "qrloop-"));
  const framesDir = join(dir, "frames");
  const text = "wifi: hunter2\nand a ✓ non-ascii line — with an em dash\n";
  try {
    execFileSync(
      PYTHON,
      [SENDER, "--text", text, "--dump-frames", framesDir, "--bytes", "500"],
      { stdio: "pipe" },
    );
    const files = readdirSync(framesDir).filter((f) => f.endsWith(".bin")).sort();
    let decoder;
    let completed = null;
    for (const entry of files) {
      const parsed = parseFrame(new Uint8Array(readFileSync(join(framesDir, entry))));
      if (!decoder) {
        decoder = new LTDecoder(parsed.header.k, parsed.header.blockLen,
          parsed.header.sessionId, parsed.header.totalLen);
      }
      decoder.addFrame(parsed.header.seq, parsed.block);
      if (decoder.isComplete) { completed = decoder.assemble(); break; }
    }
    const file = await unpackFile(completed);
    check("snippet: SHA-256 verified", await verifyFile(file));
    check("snippet: recognised as text", isSnippet(file));
    check("snippet: text round-trips", snippetText(file) === text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const compressible = Buffer.from("the payload travels as light\n".repeat(20000));
const incompressible = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < incompressible.length; i++) incompressible[i] = (i * 2654435761) & 0xff;

console.log("loopback: python sender -> browser decoder\n");
// The boundary cases are the gzip threshold (768 bytes, with a 64-byte
// hysteresis) and the single-block payload, which completes on frame one.
await roundTrip("1 byte", "tiny.bin", Buffer.from([0x42]));
await roundTrip("767 bytes (below the gzip threshold)", "small.txt", Buffer.alloc(767, 0x61));
await roundTrip("768 bytes (at the gzip threshold)", "small2.txt", Buffer.alloc(768, 0x61));
await roundTrip("580 KB compressible", "notes.txt", compressible);
await roundTrip("2 MB incompressible", "noise.bin", incompressible);
await roundTrip("utf-8 filename", "réçu—café́.txt", Buffer.from("naïve\n"));
await roundTrip("gzip disabled", "plain.txt", compressible.subarray(0, 100000), ["--no-gzip"]);
await snippetRoundTrip();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
