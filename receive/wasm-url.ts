// The 940 KB decoder wasm, fetched as a separate asset so the browser caches
// it. Isolated in its own module for the same reason as worker-factory.ts.
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

export default wasmUrl;
