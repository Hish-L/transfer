// The receiver: point a camera at a sending screen and rebuild the file.
//
// The optical link is one-way, so nothing here can ask for a retransmission.
// Every frame is a gift: decode it if you can, drop it if you can't, and let
// the fountain make up the difference. That is why frames are dropped freely
// whenever the decode workers are busy — a stale frame is worth less than the
// next one.

import { createDecodeWorker } from "./worker-factory";
import { formatBytes } from "../shared/format";
import { LTDecoder } from "../shared/fountain";
import { NoSignalHintTimer } from "../shared/no-signal";
import { renderPairQr, siblingPageUrl } from "../shared/pair-qr";
import { probeCameraCapabilities, applyAdvancedConstraint } from "../shared/platform";
import {
  estimateTransferProgress,
  expectedFountainOverhead,
  formatDuration,
} from "../shared/progress";
import { fnv1a, parseFrame, streamIdentity, unpackFile, verifyFile } from "../shared/protocol";
import type { FrameHeader, OpticalFile } from "../shared/protocol";
import { NO_SIGNAL_HINT_FRAME_BYTES, NO_SIGNAL_HINT_TX_FPS } from "../shared/send-settings";
import { isSnippet, snippetText } from "../shared/snippet";
import { statusLine } from "../shared/status-line";
import { DecodeWorkerPool } from "../shared/worker-pool";

const STATS_WINDOW_MS = 2000;
const STATS_TICK_MS = 500;
const SPARK_SAMPLES = 120; // 120 x 500 ms = the last minute

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const startBtn = el<HTMLButtonElement>("start");
const stopBtn = el<HTMLButtonElement>("stop");
const viewport = el<HTMLDivElement>("viewport");
const video = el<HTMLVideoElement>("video");
const bar = el<HTMLDivElement>("bar");
const progressEl = el<HTMLDivElement>("progress");
const progressLabel = el<HTMLElement>("progress-label");
const etaLabel = el<HTMLElement>("eta-label");
const resultEl = el<HTMLDivElement>("result");
const resultHeading = el<HTMLElement>("result-heading");
const resultSummary = el<HTMLElement>("result-summary");
const resultBody = el<HTMLDivElement>("result-body");
const stepCamera = el<HTMLLIElement>("step-camera");
const diagnosticsSummary = el<HTMLElement>("diagnostics-summary");
const spark = el<HTMLCanvasElement>("spark");
const cfgWidth = el<HTMLSelectElement>("cfg-width");
const cfgCapFps = el<HTMLSelectElement>("cfg-capfps");
const cfgWorkers = el<HTMLSelectElement>("cfg-workers");
const cameraActual = el<HTMLElement>("camera-actual");
const pairQr = el<HTMLCanvasElement>("pair-qr");
const pairUrl = el<HTMLElement>("pair-url");
const status = statusLine(el<HTMLElement>("status"));

const grab = document.createElement("canvas");

let stream: MediaStream | undefined;
let track: MediaStreamTrack | undefined;
let decoder: LTDecoder | undefined;
let streamKey = "";
let header: FrameHeader | undefined;
let startTs = 0;
let done = false;
let frameId = 0;
/** rVFC chains outlive the stream that started them and happily resume on the
 *  next one. This is what stops two capture loops racing after a restart. */
let captureGen = 0;
let statsTimer: number | undefined;

const captureTimes: number[] = [];
const decodeTimes: number[] = [];
const sparkSamples: number[] = [];

const noSignal = new NoSignalHintTimer(9000, 30000);
const pool = new DecodeWorkerPool(createDecodeWorker, onDecoded);

// -------------------------------------------------------------------- camera

async function start(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // Not a permission problem: the API does not exist at all on an insecure
    // origin, so saying "allow camera access" would send people hunting through
    // settings for a switch that isn't there.
    status.showError(
      "this browser exposes no camera here. A camera needs https — open this page over " +
        "https, not plain http over the LAN.",
    );
    return;
  }

  const askedWidth = Number(cfgWidth.value);
  const askedFps = Number(cfgCapFps.value);
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: askedWidth },
    height: { ideal: Math.round((askedWidth * 3) / 4) },
  };

  try {
    try {
      // iOS quietly hands back 30 fps for `{ ideal: 60 }` and reports success.
      // Demanding it first is the only way to actually get 60 where it exists.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: askedFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: askedFps } },
      });
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      status.showError("camera access was refused. Allow it for this site and press start again.");
    } else {
      status.showError(
        `camera could not start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  track = stream.getVideoTracks()[0];
  if (!track) {
    status.showError("that camera produced no video track.");
    return;
  }

  const caps = probeCameraCapabilities(track);
  if (caps.continuousFocus) {
    // Silent: it either takes or it doesn't, and there is nothing useful to
    // tell someone about a focus mode their camera declined.
    void applyAdvancedConstraint(track, { focusMode: "continuous" });
  }
  if (caps.maxFrameRate) {
    for (const option of cfgCapFps.options) {
      option.disabled = Number(option.value) > caps.maxFrameRate;
    }
  }

  done = false;
  decoder = undefined;
  header = undefined;
  streamKey = "";
  captureTimes.length = 0;
  decodeTimes.length = 0;
  sparkSamples.length = 0;
  resultEl.hidden = true;
  bar.classList.remove("error");
  bar.style.width = "0%";
  // Before srcObject, not after: `hidden` is `display: none !important`, and
  // WebKit will not start a display:none video. play() rejects (or resolves
  // having presented nothing), rVFC then never fires, and the capture chain is
  // dead for good — the camera is live but the page sits at 0 capture fps.
  viewport.hidden = false;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  stepCamera.setAttribute("data-done", "");
  diagnosticsSummary.textContent = "Live diagnostics";

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  if (!(await startPlayback())) {
    stop();
    status.showError("the camera stream would not start playing. Press start again.");
    return;
  }

  pool.resize(Number(cfgWorkers.value));
  reportCamera();
  const settings = track.getSettings();
  status.setStatus(
    `camera ${settings.width}×${settings.height}@${Math.round(settings.frameRate ?? 0)}` +
      ` — searching for a stream…`,
  );

  noSignal.cameraStarted(performance.now());
  statsTimer = window.setInterval(updateStats, STATS_TICK_MS);
  scheduleFrame(++captureGen);
}

/** Play the preview and wait until it is genuinely producing frames.
 *
 *  `play()` resolving is not the same fact as "there are frames": iOS can
 *  resolve it with videoWidth still 0, and the capture loop reads videoWidth on
 *  every frame. So gate on dimensions, and retry once — the first play attempt
 *  after a fresh permission grant loses a race with layout often enough to be
 *  the bug people actually hit. */
async function startPlayback(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await video.play();
    } catch {
      // AbortError/NotAllowedError here is worth one more go, not a failure.
    }
    if (await waitForFrames(2500)) return true;
  }
  return false;
}

function waitForFrames(timeoutMs: number): Promise<boolean> {
  if (video.videoWidth > 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const settle = (value: boolean): void => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("resize", onMeta);
      resolve(value);
    };
    const onMeta = (): void => {
      if (video.videoWidth > 0) settle(true);
    };
    const timer = window.setTimeout(() => settle(video.videoWidth > 0), timeoutMs);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("resize", onMeta);
  });
}

function reportCamera(): void {
  if (!track) {
    cameraActual.textContent = "camera not started";
    return;
  }
  const s = track.getSettings();
  const asked = Number(cfgCapFps.value);
  const got = Math.round(s.frameRate ?? 0);
  // Report what was negotiated, not what was requested — a camera silently
  // running at half the rate you asked for is exactly the thing you want to
  // see when the numbers look wrong.
  const fpsNote = got && got !== asked ? ` (asked ${asked})` : "";
  cameraActual.textContent =
    `camera ${s.width}×${s.height} @ ${got} fps${fpsNote} · ` +
    `${pool.size} decode worker${pool.size === 1 ? "" : "s"} · changes apply live`;
}

function stop(): void {
  captureGen++;
  if (statsTimer !== undefined) window.clearInterval(statsTimer);
  statsTimer = undefined;
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = undefined;
  track = undefined;
  video.srcObject = null;
  // Each worker holds its own ~940 KB of WASM; this is how that comes back.
  pool.resize(0);
  viewport.hidden = true;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  stepCamera.removeAttribute("data-done");
  status.setStatus("stopped");
}

// ------------------------------------------------------------- capture loop

// lib.dom types requestVideoFrameCallback as always present; Firefox has never
// shipped it, so the existence check is real and the cast is what lets us make it.
type MaybeRVFC = { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number): void {
  if (done || gen !== captureGen) return;
  const rvfc = (video as unknown as MaybeRVFC).requestVideoFrameCallback;
  const next = (): void => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  // rVFC fires once per decoded video frame rather than once per repaint, so
  // it neither misses frames on a 30 fps camera nor spins on a 120 Hz display.
  if (rvfc) rvfc.call(video, next);
  else requestAnimationFrame(next);
}

function captureFrame(): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  // Counted before the drop, so "capture fps" means frames the camera actually
  // delivered. Conflating it with frames we managed to look at would hide
  // exactly the case it exists to diagnose.
  captureTimes.push(performance.now());
  if (pool.busyCount === pool.size) return;
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  // Transferred, not copied — a 1280x960 frame is 4.9 MB and this runs 60x a second.
  pool.submit({ id: frameId++, buf: img.data.buffer, w: vw, h: vh }, [img.data.buffer]);
}

// ------------------------------------------------------------------- decode

function onDecoded(bytes: Uint8Array): void {
  if (done) return;
  // A successful zxing read, whether or not it turns out to be one of our
  // frames — the QR layer working is a distinct fact from the protocol layer
  // working, and separating them localises a fault immediately.
  decodeTimes.push(performance.now());

  const parsed = parseFrame(bytes);
  if (!parsed) return;
  header = parsed.header;

  const identity = streamIdentity(header);
  if (!decoder || streamKey !== identity) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    streamKey = identity;
    startTs = performance.now();
    status.setStatus(
      `receiving — ${header.k.toLocaleString()} blocks, ${formatBytes(header.totalLen)} on the wire`,
    );
  }
  if (noSignal.frameDecoded()) removeHint();

  decoder.addFrame(header.seq, parsed.block);
  updateProgressEstimate();

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    void finish(payload, ok, seconds);
  }
}

// ------------------------------------------------------------------- metrics

const metric = (id: string): HTMLElement => el(id);

function goodputKbs(elapsed: number): number {
  if (!decoder) return 0;
  // Discount the frames the fountain spends on redundancy, and do it as a
  // function of k. A flat 1.18 over-reports a short transfer by up to 2x,
  // because a small stream needs far more redundancy per block.
  return (
    (decoder.framesNew * decoder.blockLen) /
    expectedFountainOverhead(decoder.k) /
    1024 /
    Math.max(0.1, elapsed)
  );
}

function updateStats(): void {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]): void => {
    while (a.length > 0 && a[0]! < now - STATS_WINDOW_MS) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  // Derive the divisor from the window constant so the two cannot drift apart.
  const perSecond = (a: number[]): number => a.length / (STATS_WINDOW_MS / 1000);

  const decFps = perSecond(decodeTimes);
  metric("m-cap").textContent = perSecond(captureTimes).toFixed(0);
  metric("m-dec").textContent = decFps.toFixed(1);

  sparkSamples.push(decFps);
  if (sparkSamples.length > SPARK_SAMPLES) sparkSamples.shift();
  drawSparkline();

  if (noSignal.tick(now)) showNoSignalHint();
  if (!decoder) return;

  const elapsed = (now - startTs) / 1000;
  updateProgressEstimate();
  const seen = decoder.framesNew + decoder.framesDup;
  const overhead = decoder.framesNew / decoder.k;

  metric("m-rate").textContent = `${goodputKbs(elapsed).toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-dup").textContent = seen === 0 ? "—" : `${((decoder.framesDup / seen) * 100).toFixed(0)}%`;
  // Against the expectation, because the raw ratio means nothing without it:
  // 1.4x is healthy at k=25 and a sign of trouble at k=2000.
  metric("m-overhead").textContent =
    `${overhead.toFixed(2)}× / ${expectedFountainOverhead(decoder.k).toFixed(2)}×`;
  metric("m-pass").textContent = `${overhead.toFixed(2)}`;
  metric("m-k").textContent = decoder.k.toLocaleString();
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
  metric("m-solved").textContent = `${decoder.solvedCount}/${decoder.k}`;
}

function drawSparkline(): void {
  const ctx = spark.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = spark;
  ctx.clearRect(0, 0, w, h);
  if (sparkSamples.length < 2) return;
  // Scale to the window's own peak, floored at 5 so an idle camera doesn't
  // render noise as a mountain range.
  const peak = Math.max(5, ...sparkSamples);
  const step = w / (SPARK_SAMPLES - 1);
  ctx.beginPath();
  sparkSamples.forEach((value, i) => {
    const x = i * step;
    const y = h - (value / peak) * (h - 2) - 1;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#00ff9c";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function updateProgressEstimate(): void {
  if (!decoder) return;
  const elapsed = Math.max(0, (performance.now() - startTs) / 1000);
  const estimate = estimateTransferProgress(
    decoder.k,
    decoder.framesNew,
    elapsed,
    decoder.solvedCount,
  );
  const percent = estimate.fraction * 100;
  // One decimal below 10%, so the first half-minute of a big transfer visibly
  // moves instead of sitting on "0%".
  const shownPercent = percent < 10 ? percent.toFixed(1) : percent.toFixed(0);
  bar.style.width = `${percent.toFixed(1)}%`;
  progressEl.setAttribute("aria-valuenow", String(Math.floor(percent)));
  progressLabel.textContent = `${shownPercent}% · ${decoder.solvedCount}/${decoder.k} blocks`;
  // Held back for the first few frames: a two-frame sample reads wildly wrong.
  const rate = decoder.framesNew >= 4 ? ` · ${goodputKbs(elapsed).toFixed(1)} KB/s` : "";
  etaLabel.textContent =
    (estimate.etaSeconds === undefined
      ? estimate.phase === "decoding"
        ? `${decoder.framesNew} frames · decoding`
        : "Estimating time…"
      : `About ${formatDuration(estimate.etaSeconds)} · ${decoder.framesNew} frames`) + rate;
}

// ---------------------------------------------------------- no-signal hint

function removeHint(): void {
  document.getElementById("no-signal")?.remove();
}

function showNoSignalHint(): void {
  if (document.getElementById("no-signal")) return;
  const box = document.createElement("div");
  box.className = "hint";
  box.id = "no-signal";
  box.innerHTML =
    "<h3>Nothing is decoding yet</h3>" +
    "<ul>" +
    "<li>Fill more of this camera's view with the code, and hold still.</li>" +
    "<li>Turn the sending screen's brightness up; avoid glare and reflections.</li>" +
    `<li>On the sender, try ${NO_SIGNAL_HINT_FRAME_BYTES} bytes / frame at ` +
    `${NO_SIGNAL_HINT_TX_FPS} fps — that combination reads off almost anything.</li>` +
    "</ul>";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    noSignal.dismiss(performance.now());
    removeHint();
  });
  box.appendChild(dismiss);
  viewport.insertAdjacentElement("afterend", box);
}

// -------------------------------------------------------------------- finish

async function finish(payload: Uint8Array, checksumOk: boolean, seconds: number): Promise<void> {
  done = true;
  // Tear the pipeline down BEFORE presenting anything: the camera light going
  // out is the clearest possible signal that it is over, and the failure path
  // below has no way to recover the pipeline anyway.
  captureGen++;
  if (statsTimer !== undefined) window.clearInterval(statsTimer);
  statsTimer = undefined;
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = undefined;
  track = undefined;
  video.srcObject = null;
  pool.resize(0);
  removeHint();
  stepCamera.removeAttribute("data-done");
  startBtn.disabled = false;
  stopBtn.disabled = true;
  diagnosticsSummary.textContent = "Transfer summary";

  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  resultEl.hidden = false;
  resultEl.classList.remove("failed");
  resultBody.replaceChildren();

  try {
    if (!checksumOk) throw new Error("The optical stream checksum did not match.");
    const file = await unpackFile(payload);
    // Three independent checks, and this is the last one. Nothing reaches the
    // user before it passes.
    if (!(await verifyFile(file))) {
      throw new Error("The recovered file failed SHA-256 verification.");
    }
    present(file, payload.length, seconds);
  } catch (err) {
    bar.classList.add("error");
    resultEl.classList.add("failed");
    resultHeading.textContent = "Transfer failed";
    resultSummary.textContent = err instanceof Error ? err.message : String(err);
    progressLabel.textContent = "failed";
    etaLabel.textContent = "";
    const again = document.createElement("button");
    again.type = "button";
    again.textContent = "Start over";
    again.addEventListener("click", () => location.reload());
    resultBody.appendChild(again);
    status.showError("transfer failed");
  }
}

function present(file: OpticalFile, containerLength: number, seconds: number): void {
  // Wire bytes over wall time — deliberately a different quantity from the
  // live goodput above, which discounts fountain overhead and counts payload.
  const rate = (containerLength / 1024 / seconds).toFixed(1);
  const gzipNote = file.compression === "gzip" ? "gzip decompressed · " : "";

  if (isSnippet(file)) {
    resultHeading.textContent = "Text received";
    resultSummary.textContent =
      `text in ${seconds.toFixed(1)} s · ${rate} KB/s · ${gzipNote}SHA-256 verified ✓`;
    const text = snippetText(file);
    const pre = document.createElement("pre");
    pre.textContent = text;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy text";
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(text).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy text"), 1400);
      });
    });
    resultBody.append(pre, copy);
    progressLabel.textContent = "100% · text recovered";
  } else {
    resultHeading.textContent = "File received";
    const kb = Math.round(file.bytes.length / 1024);
    resultSummary.textContent =
      `${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · ${gzipNote}SHA-256 verified ✓`;
    const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    const download = document.createElement("a");
    download.href = url;
    download.download = file.name;
    download.textContent = `Save ${file.name}`;
    resultBody.appendChild(download);
    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = file.name;
      resultBody.appendChild(img);
    }
    progressLabel.textContent = "100% · file recovered";
  }
  etaLabel.textContent = `${formatDuration(seconds)} total`;
  status.setStatus("done — SHA-256 verified");
}

// -------------------------------------------------------------------- wiring

startBtn.addEventListener("click", () => void start());
stopBtn.addEventListener("click", stop);

// Same dead-chain hazard from the other direction: iOS pauses the preview when
// the tab is backgrounded (a call, the lock screen, an app switch), and a
// paused video presents no frames, so the rVFC chain never resumes on its own.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !stream || done) return;
  void video.play().catch(() => undefined);
});

for (const control of [cfgWidth, cfgCapFps]) {
  control.addEventListener("change", () => {
    if (!track) return;
    const width = Number(cfgWidth.value);
    void track
      .applyConstraints({
        width: { ideal: width },
        height: { ideal: Math.round((width * 3) / 4) },
        frameRate: { ideal: Number(cfgCapFps.value) },
      })
      .then(reportCamera)
      .catch(() => {
        // iOS in particular refuses live constraint changes. Tearing the stream
        // down to honour a settings tweak would abandon a transfer in flight,
        // which is a far worse outcome than the setting not applying.
        cameraActual.textContent = "this camera refused a live change — restart to apply";
      });
  });
}

cfgWorkers.addEventListener("change", () => {
  if (!track) return;
  pool.resize(Number(cfgWorkers.value));
  reportCamera();
});

// The pairing code sends the other device to the sender.
const sendUrl = siblingPageUrl("../send/");
pairUrl.textContent = sendUrl;
renderPairQr(pairQr, sendUrl, 132);
