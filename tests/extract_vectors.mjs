// Dump wire-format golden vectors from the TypeScript codec as JSON, so the
// Python sender can be asserted against the implementation the browser
// actually runs rather than against a transcription of it.
//
// Transcribing vectors into the Python test file is exactly how two
// implementations drift: the moment someone "fixes" a failing constant, the
// test is measuring nothing. Generating them means a genuine wire-format
// change fails on the next run, loudly, on both sides at once.
//
//   node --import tsx tests/extract_vectors.mjs > vectors.json

import { dlog, frameIndices, solitonCdf, LTEncoder } from "../shared/fountain.ts";
import { fnv1a, packFile, packFrame } from "../shared/protocol.ts";

const hex32 = (n) => `0x${n.toString(16).padStart(8, "0")}`;
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** The filler the upstream stream fingerprints were recorded against. */
function testPayload(byteLength) {
  const payload = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) payload[i] = (i * 37 + (i >> 8) * 11) & 0xff;
  return payload;
}

// --- dlog, swept over both domains solitonCdf can reach ---------------------
const sweep = new Float64Array(65535 + 64 * 4096);
let sweepCount = 0;
for (let k = 1; k <= 65535; k++) sweep[sweepCount++] = dlog(2 * k);
for (let i = 64; i < 64 * 4096; i++) sweep[sweepCount++] = dlog(i / 64);
// Hash only the filled prefix — the array is over-allocated, and folding its
// trailing zeros in would give a fingerprint that matches nothing upstream.
const dlogSweepFnv = hex32(fnv1a(new Uint8Array(sweep.buffer, 0, sweepCount * 8)));

// --- soliton CDF fingerprints ----------------------------------------------
const cdfKs = [1, 2, 3, 17, 179, 716, 5000, 22000, 65535];
const solitonCdfFnv = {};
for (const k of cdfKs) {
  const cdf = solitonCdf(k);
  solitonCdfFnv[k] = hex32(fnv1a(new Uint8Array(cdf.buffer, cdf.byteOffset, cdf.byteLength)));
}

// --- frame index subsets ----------------------------------------------------
// Extends upstream's matrix past 2^31. Upstream has no vector there, and
// frameSeed leans on JS's ToInt32 truncation of `seq + 0x85ebca6b` to wrap —
// a Python port that forgets to mask would agree everywhere upstream tests and
// diverge only after two billion frames.
const indexKs = [1, 2, 17, 179, 716, 4096, 65535];
const indexSeqs = [0, 1, 2, 41, 1000, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 0x85ebca6b, 0x7a143594];
const frameIndicesVectors = {};
for (const k of indexKs) {
  const cdf = solitonCdf(k);
  frameIndicesVectors[k] = {};
  for (const seq of indexSeqs) {
    frameIndicesVectors[k][seq] = frameIndices(k, cdf, 4242, seq);
  }
}

// --- full encoded streams ---------------------------------------------------
// blockLen 33 is deliberately not a multiple of 4: it exercises the word
// padding the encoder adds internally and then trims off the wire.
const streamCases = [
  [1, 64, 1],
  [23, 64, 7],
  [179, 2933, 4242],
  [716, 1445, 65535],
  [5000, 33, 1],
  [65535, 86, 7],
  [13, 1153, 999],
];
const streamFnv = {};
for (const [k, blockLen, sessionId] of streamCases) {
  const encoder = new LTEncoder(testPayload(k * blockLen - 7), blockLen, sessionId);
  const stream = new Uint8Array(64 * blockLen);
  for (let seq = 0; seq < 64; seq++) stream.set(encoder.encode(seq), seq * blockLen);
  streamFnv[`${k}/${blockLen}/${sessionId}`] = {
    k: encoder.k,
    fnv: hex32(fnv1a(stream)),
  };
}

// --- frame header packing ---------------------------------------------------
const frameBytes = hex(
  packFrame(
    { sessionId: 4242, seq: 0x7fffffff, k: 179, blockLen: 16, totalLen: 2861, payloadFnv: 0xdeadbeef },
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
  ),
);

// --- container packing ------------------------------------------------------
// Only the uncompressed path is pinned byte-for-byte. Two gzip implementations
// legitimately produce different bytes for the same input, so the Python side
// asserts its gzip container by decompressing it, not by comparing hashes.
const smallText = new TextEncoder().encode("the payload travels as light\n");
const container = await packFile("notes.txt", "text/plain", smallText);
const containerVector = {
  name: "notes.txt",
  type: "text/plain",
  input: hex(smallText),
  compression: container.compression,
  bytes: hex(container.container),
};

// A compressible payload above the 768-byte gzip threshold, to pin the
// decision rule (not the bytes).
const compressible = new TextEncoder().encode("abcabcabc\n".repeat(400));
const gz = await packFile("repeat.txt", "text/plain", compressible);
const gzipDecision = {
  input: hex(compressible),
  compression: gz.compression,
  originalSize: gz.originalSize,
  headerBytes: hex(gz.container.subarray(0, 49)),
};

// Just under the threshold: must not be gzipped however compressible it is.
const belowThreshold = new TextEncoder().encode("a".repeat(767));
const below = await packFile("small.txt", "text/plain", belowThreshold);

process.stdout.write(
  `${JSON.stringify(
    {
      dlogSweepFnv,
      solitonCdfFnv,
      frameIndices: frameIndicesVectors,
      streamFnv,
      frameBytes,
      container: containerVector,
      gzipDecision,
      belowThreshold: { input: hex(belowThreshold), compression: below.compression },
    },
    null,
    2,
  )}\n`,
);
