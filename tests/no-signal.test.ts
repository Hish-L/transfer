import assert from "node:assert/strict";
import test from "node:test";
import { NoSignalHintTimer } from "../shared/no-signal.ts";

const DELAY = 8_000;
const REDELAY = 15_000;
const timer = () => new NoSignalHintTimer(DELAY, REDELAY);

test("nothing fires before the camera starts", () => {
  const t = timer();
  assert.equal(t.tick(0), false);
  assert.equal(t.tick(1_000_000), false, "an unstarted timer must never fire");
  assert.equal(t.isVisible, false);
});

test("it fires once, after the delay, and not again on its own", () => {
  const t = timer();
  t.cameraStarted(0);
  assert.equal(t.tick(DELAY), false, "not at exactly the delay");
  assert.equal(t.tick(DELAY + 1), true);
  assert.equal(t.isVisible, true);
  // Every subsequent tick must be silent, or the receiver would re-render the
  // panel twice a second for the rest of the transfer.
  for (const now of [DELAY + 2, DELAY + 500, 10 * DELAY]) {
    assert.equal(t.tick(now), false, `fired again at ${now}`);
  }
});

test("dismissing hides it and restarts the countdown on the longer delay", () => {
  const t = timer();
  t.cameraStarted(0);
  assert.equal(t.tick(DELAY + 1), true);

  t.dismiss(DELAY + 1);
  assert.equal(t.isVisible, false);

  assert.equal(t.tick(DELAY + 1 + DELAY + 1), false, "the first delay no longer applies");
  assert.equal(t.tick(DELAY + 1 + REDELAY), false, "not at exactly the longer delay");
  assert.equal(t.tick(DELAY + 1 + REDELAY + 1), true, "comes back after the longer delay");
  assert.equal(t.isVisible, true);
});

test("it keeps coming back for as long as nothing decodes", () => {
  const t = timer();
  t.cameraStarted(0);
  let now = DELAY + 1;
  assert.equal(t.tick(now), true, "first round did not fire");
  t.dismiss(now);
  for (let round = 2; round <= 5; round++) {
    now += REDELAY + 1;
    assert.equal(t.tick(now), true, `round ${round} did not re-arm`);
    t.dismiss(now);
  }
});

test("a camera restart after a dismissal goes back to the short delay", () => {
  const t = timer();
  t.cameraStarted(0);
  assert.equal(t.tick(DELAY + 1), true);
  t.dismiss(DELAY + 1);

  t.cameraStarted(30_000);
  assert.equal(t.tick(30_000 + DELAY - 1), false);
  assert.equal(t.tick(30_000 + DELAY + 1), true, "a fresh attempt uses the fresh-attempt delay");
});

test("the first decoded frame ends it for good", () => {
  const t = timer();
  t.cameraStarted(0);
  assert.equal(t.tick(DELAY + 1), true);

  assert.equal(t.frameDecoded(), true, "reports that the panel needs removing");
  assert.equal(t.isVisible, false);
  assert.equal(t.tick(100 * DELAY), false, "must never return once a frame has decoded");
});

test("a frame decoded while the hint is hidden reports nothing to remove", () => {
  const t = timer();
  t.cameraStarted(0);
  assert.equal(t.frameDecoded(), false);
  assert.equal(t.tick(100 * DELAY), false);
});

test("a decoded frame outlasts a later camera restart", () => {
  // Settings can restart the pipeline; having already seen a frame means the
  // link works, so the advice would be wrong.
  const t = timer();
  t.cameraStarted(0);
  t.frameDecoded();
  t.cameraStarted(50_000);
  assert.equal(t.tick(50_000 + DELAY + 1), false);
});

test("restarting the camera before any frame re-arms from the new start", () => {
  const t = timer();
  t.cameraStarted(0);
  t.cameraStarted(30_000);
  assert.equal(t.tick(30_000 + DELAY - 1), false, "measured from the old start, not the new one");
  assert.equal(t.tick(30_000 + DELAY + 1), true);
});
