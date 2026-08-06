// Paint a QR module matrix into a pixel buffer, quiet zone included.
//
// Pure so it can be golden-tested in Node, where ImageData does not exist:
// the pixels are RGBA bytes viewed as one little-endian u32 per pixel, which
// is exactly an ImageData buffer — the sender wraps the result with
// `new ImageData(new Uint8ClampedArray(pixels.buffer), size, size)` at no copy.

const WHITE = 0xffffffff;
const BLACK = 0xff000000; // opaque black: alpha in the high byte, little-endian

export interface QrRaster {
  /** Pixels per side: moduleCount + 2 × margin. One module = one pixel — the
   *  sender scales up with imageSmoothingEnabled off. */
  size: number;
  /** `<ArrayBuffer>` because ImageData refuses an ArrayBufferLike-backed view. */
  pixels: Uint32Array<ArrayBuffer>;
}

/** `modules` is row-major, truthy = dark — the qrcode lib's `qr.modules.data`. */
export function rasterizeQr(
  moduleCount: number,
  modules: ArrayLike<number>,
  margin: number,
): QrRaster {
  const size = moduleCount + 2 * margin;
  const pixels = new Uint32Array(size * size);
  pixels.fill(WHITE);
  for (let y = 0; y < moduleCount; y++) {
    const row = (y + margin) * size + margin;
    const src = y * moduleCount;
    for (let x = 0; x < moduleCount; x++) {
      if (modules[src + x]) pixels[row + x] = BLACK;
    }
  }
  return { size, pixels };
}
