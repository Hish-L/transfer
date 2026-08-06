import assert from "node:assert/strict";
import test from "node:test";
import { rasterizeQr } from "../shared/qr-raster.ts";

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

test("a single dark module with no margin is one black pixel", () => {
  const { size, pixels } = rasterizeQr(1, [1], 0);
  assert.equal(size, 1);
  assert.deepEqual([...pixels], [BLACK]);
});

test("the margin surrounds the modules with white on every side", () => {
  const { size, pixels } = rasterizeQr(1, [1], 2);
  assert.equal(size, 5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const expected = x === 2 && y === 2 ? BLACK : WHITE;
      assert.equal(pixels[y * size + x], expected, `pixel (${x},${y})`);
    }
  }
});

test("modules map row-major and truthy means dark", () => {
  // ▓░ / ░▓ checkerboard
  const { size, pixels } = rasterizeQr(2, [1, 0, 0, 1], 0);
  assert.equal(size, 2);
  assert.deepEqual([...pixels], [BLACK, WHITE, WHITE, BLACK]);
});

test("an all-light matrix rasterizes to all white", () => {
  const { size, pixels } = rasterizeQr(3, new Uint8Array(9), 1);
  assert.equal(size, 5);
  assert.ok([...pixels].every((p) => p === WHITE));
});

test("pixel values are the RGBA bytes an ImageData buffer expects", () => {
  const { pixels } = rasterizeQr(1, [1], 1);
  const bytes = new Uint8Array(pixels.buffer);
  // little-endian u32 0xff000000 → R,G,B = 0 and A = 255
  const center = 4 * (1 * 3 + 1);
  assert.deepEqual([...bytes.slice(center, center + 4)], [0, 0, 0, 255]);
  // and the white corner is R,G,B,A all 255
  assert.deepEqual([...bytes.slice(0, 4)], [255, 255, 255, 255]);
});
