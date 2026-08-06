import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";
import { cliPayload } from "./build/cli-payload";
import { htmlTokens } from "./build/html-tokens";
import { MAX_FILE_LABEL } from "./shared/protocol";
import { MAX_SNIPPET_LABEL } from "./shared/snippet";
import { FRAME_BYTES_OPTIONS, TX_FPS_OPTIONS, DEFAULT_FRAME_BYTES, DEFAULT_TX_FPS } from "./shared/send-settings";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = createRequire(import.meta.url)("./package.json") as { version: string };

const options = (values: readonly number[], selected: number, label: (n: number) => string) =>
  values
    .map((n) => `<option value="${n}"${n === selected ? " selected" : ""}>${label(n)}</option>`)
    .join("");

const TOKENS = {
  MAX_FILE_LABEL,
  MAX_SNIPPET_LABEL,
  APP_VERSION: pkg.version,
  // The pickers are generated from the same constants the sender enforces, so
  // an option can never offer a frame size the encoder would reject.
  TX_FPS_OPTIONS: options(TX_FPS_OPTIONS, DEFAULT_TX_FPS, (n) => `${n} fps`),
  FRAME_BYTES_OPTIONS: options(FRAME_BYTES_OPTIONS, DEFAULT_FRAME_BYTES, (n) => `${n} B`),
};

export default defineConfig({
  // Relative, so the same dist works at github.io/transfer/, at a custom
  // domain, and from a local `vite preview` without a rebuild.
  base: "./",
  plugins: [
    htmlTokens(TOKENS),
    // getUserMedia does not exist on an insecure origin, so a phone opening the
    // dev server over the LAN would get no camera at all without this.
    basicSsl(),
    cliPayload(root, pkg.version),
  ],
  build: {
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        send: resolve(root, "send/index.html"),
        receive: resolve(root, "receive/index.html"),
      },
    },
  },
  server: { host: true },
  preview: { host: true },
});
