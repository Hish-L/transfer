import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateTransferProgress,
  expectedFountainOverhead,
  formatDuration,
} from "../shared/progress.ts";

// k=100 is a ~300 KB file at 2953 bytes/frame — a very ordinary transfer, and
// the size at which the flat 1.18 this replaced was most wrong.
// overhead(100) = 1.345, so 135 expected frames and 35 of expected redundancy.
const K = 100;
const EXPECTED_FRAMES = 135;

test("expected overhead falls with k and never promises less than the fountain costs", () => {
  // Recorded p50s from 200 trials per k. The model must sit at or above them:
  // an ETA that quotes too little and then keeps slipping reads as a stall.
  const measured: [number, number][] = [
    [50, 1.38],
    [100, 1.31],
    [200, 1.26],
    [400, 1.22],
    [800, 1.18],
    [1600, 1.15],
  ];
  for (const [k, p50] of measured) {
    const modelled = expectedFountainOverhead(k);
    assert.ok(modelled >= p50, `k=${k}: model ${modelled.toFixed(3)} under-promises vs ${p50}`);
    assert.ok(modelled < p50 * 1.15, `k=${k}: model ${modelled.toFixed(3)} is needlessly pessimistic`);
  }

  let previous = Infinity;
  for (const k of [1, 5, 25, 50, 100, 500, 5000, 65535]) {
    const value = expectedFountainOverhead(k);
    assert.ok(value <= previous, `overhead rose at k=${k}`);
    previous = value;
  }
  assert.equal(expectedFountainOverhead(1), 1.6, "clamped for tiny streams");
  assert.equal(expectedFountainOverhead(65535), 1.15, "clamped at the asymptote");
  assert.equal(expectedFountainOverhead(0), 1.6, "guards against a zero-block stream");
});

test("progress and ETA follow the observed unique-frame rate", () => {
  const progress = estimateTransferProgress(K, 50, 10);
  assert.equal(progress.expectedFrames, EXPECTED_FRAMES);
  assert.equal(progress.fraction, 0.43);
  assert.equal(progress.phase, "collecting");
  // 85 frames still wanted at the observed 5 frames/s.
  assert.equal(progress.etaSeconds, 17);
});

test("progress keeps moving through redundant frames", () => {
  const at = (frames: number) => estimateTransferProgress(K, frames, 20).fraction;

  assert.equal(estimateTransferProgress(K, 2, 4).etaSeconds, undefined, "too early to guess");
  assert.equal(at(K), 0.86, "the theoretical minimum is 86% of the bar");
  assert.ok(at(110) > 0.88 && at(110) < 0.9);
  assert.ok(Math.abs(at(EXPECTED_FRAMES) - 0.96) < 1e-9, "expected frames lands on 96%");
  assert.ok(at(EXPECTED_FRAMES + 18) > 0.96, "running long still creeps forward");
  assert.ok(at(EXPECTED_FRAMES * 4) < 0.99, "and never reaches 100% on frame count alone");
});

test("the ETA keeps quoting a time once a stream runs long", () => {
  // Past the expected count the target steps up one redundancy block at a time
  // rather than going silent — which is exactly when someone is wondering
  // whether the transfer has stalled.
  const overrun = estimateTransferProgress(K, EXPECTED_FRAMES + 5, 30);
  assert.ok(overrun.etaSeconds !== undefined && overrun.etaSeconds > 0);
  assert.equal(overrun.phase, "decoding");
});

test("decoded blocks can advance progress and completion caps at 99%", () => {
  assert.equal(estimateTransferProgress(K, 105, 20, 95).fraction, 0.9405);
  assert.equal(estimateTransferProgress(K, 105, 20, 100).fraction, 0.99);
});

test("durations stay compact and readable", () => {
  assert.equal(formatDuration(12.1), "13s");
  assert.equal(formatDuration(75.1), "1m 16s");
  assert.equal(formatDuration(3_661), "1h 1m");
});
