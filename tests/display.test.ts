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
