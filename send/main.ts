// The sender: turn a file into an endless stream of fountain-coded QR codes.
//
// There is no back-channel and no completion signal. This page has no idea
// whether anyone is watching, so it never stops on its own — it just keeps
// emitting frames until a human stops it.

import QRCode from "qrcode";
import { fitQrDisplaySize } from "../shared/display";
import { formatBytes } from "../shared/format";
import { LTEncoder } from "../shared/fountain";
import {
  fitsInOneStream,
  blockLength,
  minimumFrameBytes,
  smallestSufficientFrameSize,
} from "../shared/frame-capacity";
import { fnv1a, packFile, packFrame, type CompressionMode } from "../shared/protocol";
import { rasterizeQr } from "../shared/qr-raster";
import { MAX_SNIPPET_BYTES, MAX_SNIPPET_LABEL, packSnippet } from "../shared/snippet";
import { statusLine } from "../shared/status-line";
import { requestScreenWakeLock } from "../shared/wake-lock";

const MARGIN = 4; // quiet zone, in modules
const LOOKAHEAD = 3;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const cfgFile = el<HTMLInputElement>("cfg-file");
const cfgText = el<HTMLTextAreaElement>("cfg-text");
const cfgFps = el<HTMLSelectElement>("cfg-fps");
const cfgBytes = el<HTMLSelectElement>("cfg-bytes");
const cfgEcc = el<HTMLSelectElement>("cfg-ecc");
const cfgSize = el<HTMLInputElement>("cfg-size");
const startBtn = el<HTMLButtonElement>("start");
const stopBtn = el<HTMLButtonElement>("stop");
const fullBtn = el<HTMLButtonElement>("full");
const exitFullBtn = el<HTMLButtonElement>("exit-full");
const stage = el<HTMLDivElement>("stage");
const canvas = el<HTMLCanvasElement>("qr");
const specsHeading = el<HTMLElement>("specs-heading");
const specs = el<HTMLDivElement>("stream-specs");
const status = statusLine(el<HTMLElement>("status"));

// Off-screen 1px-per-module canvas. The visible canvas is an integer multiple
// of it, so every module lands on an exact block of pixels.
const staging = document.createElement("canvas");

/** Bumped on every restart. Any loop or async continuation that sees a stale
 *  generation returns instead of fighting the new stream for the canvas. */
let generation = 0;
let streaming = false;

interface Source {
  name: string;
  type: string;
  size: number;
  container: Uint8Array;
  compression: CompressionMode;
  transmittedSize: number;
}
let source: Source | undefined;

function setControls(): void {
  startBtn.disabled = streaming || !hasInput();
  stopBtn.disabled = !streaming;
  fullBtn.disabled = !streaming;
}

const hasInput = (): boolean => !!cfgFile.files?.[0] || cfgText.value.trim().length > 0;

// ---------------------------------------------------------------- selection

cfgFile.addEventListener("change", () => {
  if (cfgFile.files?.[0]) cfgText.value = "";
  source = undefined;
  setControls();
  const file = cfgFile.files?.[0];
  status.setStatus(
    file ? `${file.name} — ${formatBytes(file.size)}, ready` : "pick a file, or paste some text",
  );
});

cfgText.addEventListener("input", () => {
  if (cfgText.value.trim()) cfgFile.value = "";
  source = undefined;
  setControls();
  const bytes = new TextEncoder().encode(cfgText.value).length;
  status.setStatus(
    bytes === 0
      ? "pick a file, or paste some text"
      : bytes > MAX_SNIPPET_BYTES
        ? `snippet is ${formatBytes(bytes)} — the cap is ${MAX_SNIPPET_LABEL}`
        : `text snippet — ${formatBytes(bytes)}, ready`,
  );
});

/** Pack once per selection, not once per restart: gzip and SHA-256 over a
 *  64 MB file are not something to redo because someone nudged the fps. */
async function prepare(): Promise<Source> {
  if (source) return source;
  const file = cfgFile.files?.[0];
  if (file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const packed = await packFile(file.name, file.type, bytes);
    source = {
      name: file.name,
      type: file.type || "application/octet-stream",
      size: bytes.length,
      container: packed.container,
      compression: packed.compression,
      transmittedSize: packed.transmittedSize,
    };
    return source;
  }
  const packed = await packSnippet(cfgText.value);
  source = {
    name: "text snippet",
    type: "text",
    size: packed.originalSize,
    container: packed.container,
    compression: packed.compression,
    transmittedSize: packed.transmittedSize,
  };
  return source;
}

// ------------------------------------------------------------------ display

function layout(moduleTotal: number): number {
  const dpr = window.devicePixelRatio || 1;
  const cssBudget = document.body.classList.contains("qr-full")
    ? Math.min(window.innerWidth, window.innerHeight)
    : fitQrDisplaySize(
        window.innerWidth,
        window.innerHeight,
        stage.clientWidth || window.innerWidth,
        Number(cfgSize.value),
      );
  // Floor to an integer so no module is resampled across a pixel boundary —
  // a half-pixel of blur is the difference between a code that reads at arm's
  // length and one that doesn't.
  const scale = Math.max(1, Math.floor((cssBudget * dpr) / moduleTotal));
  staging.width = moduleTotal;
  staging.height = moduleTotal;
  canvas.width = moduleTotal * scale;
  canvas.height = moduleTotal * scale;
  canvas.style.width = `${(moduleTotal * scale) / dpr}px`;
  canvas.style.height = `${(moduleTotal * scale) / dpr}px`;
  return scale;
}

// ------------------------------------------------------------------ the loop

async function startStream(): Promise<void> {
  const gen = ++generation;
  let packed: Source;
  try {
    status.setStatus("packing…");
    packed = await prepare();
  } catch (err) {
    status.showError(err instanceof Error ? err.message : String(err));
    return;
  }
  if (gen !== generation) return;

  const frameBytes = Number(cfgBytes.value);
  const txFps = Number(cfgFps.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const payload = packed.container;

  // k is a u16, so the real ceiling is a function of frame size, not of
  // MAX_FILE_BYTES — at 500 bytes a frame it is about 30 MB.
  if (!fitsInOneStream(payload.length, frameBytes)) {
    const offered = [...cfgBytes.options].map((o) => Number(o.value));
    const suggestion =
      smallestSufficientFrameSize(payload.length, offered) ?? minimumFrameBytes(payload.length);
    status.showError(
      `${formatBytes(payload.length)} needs more than 65,535 blocks at ${frameBytes} bytes ` +
        `a frame. Raise bytes / frame to ${suggestion} or more.`,
    );
    return;
  }

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const encoder = new LTEncoder(payload, blockLength(frameBytes), sessionId);
  const payloadFnv = fnv1a(payload);
  let seq = 0;
  let version: number | undefined;

  const makeFrame = (): ImageData => {
    const thisSeq = seq++;
    const bytes = packFrame(
      {
        sessionId,
        seq: thisSeq,
        k: encoder.k,
        blockLen: encoder.blockLen,
        totalLen: payload.length,
        payloadFnv,
      },
      encoder.encode(thisSeq),
    );
    const qr = QRCode.create(
      // The lib types `data` as string, but byte mode takes a Uint8Array — and
      // it has to, because the payload is raw binary, not text.
      [{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment],
      {
        errorCorrectionLevel: ecc,
        version,
        // Pinned. The spec's 8-way mask penalty evaluation costs about 4x the
        // generation time, and the chosen mask travels in the format info, so
        // any decoder reads this one fine.
        maskPattern: 4,
      },
    );
    if (version === undefined) {
      // Lock the version on the first frame. If it floated, the code would
      // change physical size mid-stream and every camera would have to refind
      // and refocus it.
      version = qr.version;
      layout(qr.modules.size + 2 * MARGIN);
      specsHeading.hidden = false;
      specs.hidden = false;
      el("spec-fps").textContent = `${txFps} fps`;
      el("spec-frame").textContent = `${frameBytes} bytes`;
      el("spec-qr").textContent = `V${version} · ECC ${ecc}`;
      el("spec-k").textContent = `K = ${encoder.k.toLocaleString()}`;
      el("spec-compression").textContent =
        packed.compression === "gzip" ? `gzip → ${formatBytes(packed.transmittedSize)}` : "none";
      el("spec-payload").textContent = `${packed.name} · ${formatBytes(packed.size)}`;
    }
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, MARGIN);
    return new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
  };

  const queue: ImageData[] = [];
  let generatorFailed = false;
  const pump = (max = LOOKAHEAD): void => {
    if (generatorFailed || gen !== generation) return;
    try {
      for (let n = 0; n < max && queue.length < LOOKAHEAD; n++) queue.push(makeFrame());
    } catch (err) {
      // Almost always "data too long for this version at this ECC level".
      generatorFailed = true;
      status.showError(
        err instanceof Error
          ? `${err.message} — try a smaller frame size or a lower error correction level.`
          : String(err),
      );
    }
  };
  // Unhide BEFORE the first frame: makeFrame() lays the canvas out against
  // stage.clientWidth, and a hidden element measures 0 — which would collapse
  // the display budget and render the whole stream at one pixel per module.
  stage.hidden = false;
  pump();
  if (generatorFailed) {
    stage.hidden = true;
    return;
  }

  streaming = true;
  setControls();
  status.setStatus(
    `streaming ${packed.name} — ${encoder.k.toLocaleString()} blocks at ${txFps} fps · ` +
      `stop it when the receiver says verified`,
  );
  void requestScreenWakeLock();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number): void => {
    if (gen !== generation || generatorFailed) return;
    // Re-schedule before doing the work, so a slow frame costs one frame of
    // pacing rather than dropping out of the loop entirely.
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    pump(1); // at most one generation per tick — see the note below
    if (!img) {
      nextAt = now + interval;
      return;
    }
    staging.getContext("2d")!.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    // `+= interval`, not `= now + interval`: the latter accumulates rAF jitter
    // into a drift that visibly slows the stream down over a minute.
    nextAt += interval;
    // …but if we genuinely fell behind (a tab switch, a long GC), resync rather
    // than firing a burst of frames no camera will resolve.
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);
}

// Refitting on resize keeps the code as large as the viewport allows without
// touching the QR version: the module count is fixed for the life of a stream,
// only the pixel scale moves. Registered once, at module scope — a listener
// per stream would leak one on every settings change.
window.addEventListener("resize", () => {
  if (streaming && staging.width) layout(staging.width);
});

function stopStream(): void {
  generation++;
  streaming = false;
  stage.hidden = true;
  document.body.classList.remove("qr-full");
  exitFullBtn.hidden = true;
  setControls();
  status.setStatus("stopped");
}

// ------------------------------------------------------------------- wiring

startBtn.addEventListener("click", () => void startStream());
stopBtn.addEventListener("click", stopStream);

for (const control of [cfgFps, cfgBytes, cfgEcc]) {
  control.addEventListener("change", () => {
    if (streaming) void startStream();
  });
}
// Size is display-only: it never changes a byte on the wire, so it refits
// rather than restarting the stream.
cfgSize.addEventListener("input", () => {
  if (streaming && staging.width) layout(staging.width);
});

const enterFull = (): void => {
  document.body.classList.add("qr-full");
  exitFullBtn.hidden = false;
  if (staging.width) layout(staging.width);
};
const leaveFull = (): void => {
  document.body.classList.remove("qr-full");
  exitFullBtn.hidden = true;
  if (staging.width) layout(staging.width);
};
fullBtn.addEventListener("click", enterFull);
exitFullBtn.addEventListener("click", leaveFull);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("qr-full")) leaveFull();
});

setControls();
