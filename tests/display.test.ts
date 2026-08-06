import assert from "node:assert/strict";
import test from "node:test";
import { fitQrDisplaySize } from "../shared/display.ts";

test("QR display fits inside its container including padding", () => {
  assert.equal(fitQrDisplaySize(1440, 1000, 720, 900, 40), 680);
});

test("QR display still respects the requested and viewport sizes", () => {
  assert.equal(fitQrDisplaySize(1440, 1000, 1200, 600, 40), 600);
  assert.equal(fitQrDisplaySize(390, 844, 366, 900, 40), 326);
});

test("measured vertical chrome replaces the blind edge allowance", () => {
  // 1000 tall with 240 of metrics and buttons under the code leaves 760 —
  // not 0.9 * 760, which would pay the allowance a second time.
  assert.equal(fitQrDisplaySize(1440, 1000, 1200, 900, 0, 240), 760);
  // …and it is still only ever one of several ceilings.
  assert.equal(fitQrDisplaySize(1440, 1000, 1200, 500, 0, 240), 500);
  assert.equal(fitQrDisplaySize(1440, 1000, 600, 900, 0, 240), 600);
});
