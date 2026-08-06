import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Emit the terminal sender and its bootstrap into the site root, with the
 * bootstrap's integrity pin computed from the payload it will actually fetch.
 *
 * The pin has to be a build artifact. Hand-editing a SHA-256 into a shell
 * script means that every time qrsend.py changes, there is a window where the
 * published qr.sh refuses to run — and the obvious "fix" for that is to stop
 * checking, which is worse than never having pinned it. Computing it here makes
 * the two files impossible to skew: they are written in the same pass, from the
 * same bytes, into the same deploy.
 */
export function cliPayload(root: string, version: string): Plugin {
  return {
    name: "cli-payload",
    generateBundle() {
      const payload = readFileSync(resolve(root, "cli/qrsend.py"), "utf8");
      const sha = createHash("sha256").update(payload, "utf8").digest("hex");
      const template = readFileSync(resolve(root, "cli/qr.sh.in"), "utf8");

      const bootstrap = template
        .replaceAll("@PAYLOAD_SHA256@", sha)
        .replaceAll("@VERSION@", version);

      const leftover = /@[A-Z][A-Z0-9_]*@/.exec(bootstrap);
      if (leftover) throw new Error(`unsubstituted bootstrap token ${leftover[0]}`);

      this.emitFile({ type: "asset", fileName: "qr.sh", source: bootstrap });
      this.emitFile({ type: "asset", fileName: "qrsend.py", source: payload });
    },
  };
}
