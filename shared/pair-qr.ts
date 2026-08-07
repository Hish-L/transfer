// The pairing QR: a small, static code holding the *other* page's URL, so the
// second device can point its ordinary camera app at this screen and land in
// the opposite mode instead of typing the address out.

import QRCode from "qrcode";
import { rasterizeQr } from "./qr-raster";

const MARGIN = 4; // quiet zone, in modules — same as the stream

/**
 * Resolve `relative` against the *directory* `href` names, so the deploy prefix
 * survives — `/transfer/send/` + `../receive/` is `/transfer/receive/`, not
 * `/receive/`. Pure, and separate from the `location` read below, because the
 * only interesting part is the normalising and that is worth testing.
 *
 * `new URL()` alone is not enough: it resolves against the last slash, so a
 * trailing-slash-less `/transfer/send` would climb one level too far and land
 * at the domain root. Pages 301s that slash into place, but a hand-typed URL,
 * a `file://` copy or a static server that doesn't redirect would not.
 */
export function siblingUrl(href: string, relative: string): string {
  let base = href.replace(/[?#].*$/, "");
  base = base.replace(/[^/]*\.html$/, ""); // an explicit index.html is the directory
  if (!base.endsWith("/")) base += "/";
  return new URL(relative, base).href;
}

/** Absolute URL of a sibling page, derived from where this page is served from
 *  so it survives GitHub Pages, a custom domain, `vite preview` and LAN dev. */
export function siblingPageUrl(relative: string): string {
  return siblingUrl(location.href, relative);
}

/** Draw `url` into `canvas` as a crisp QR roughly `cssSize` px on a side. */
export function renderPairQr(canvas: HTMLCanvasElement, url: string, cssSize: number): void {
  // Plain string data, unlike the stream: the lib picks its own version and
  // mask, and text mode packs a URL far tighter than bytes would.
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const raster = rasterizeQr(qr.modules.size, qr.modules.data, MARGIN);

  const staging = document.createElement("canvas");
  staging.width = raster.size;
  staging.height = raster.size;
  staging
    .getContext("2d")!
    .putImageData(
      new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size),
      0,
      0,
    );

  // Integer scale, so every module lands on an exact block of device pixels.
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.max(1, Math.floor((cssSize * dpr) / raster.size));
  const pixels = raster.size * scale;
  canvas.width = pixels;
  canvas.height = pixels;
  canvas.style.width = `${pixels / dpr}px`;
  canvas.style.height = `${pixels / dpr}px`;

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(staging, 0, 0, pixels, pixels);
}
