// A module worker fetched by URL, so the browser caches it across visits.
//
// Kept as its own module rather than inlined at the call site: it is the seam
// an offline/single-file build would swap out, and a runtime branch will not
// do — `?worker&inline` builds a Blob at module scope, so Rollup cannot prove
// it side-effect-free and keeps its ~45 KB of base64 even when the branch is
// provably dead.
export function createDecodeWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}
