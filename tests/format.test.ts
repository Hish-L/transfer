import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes } from "../shared/format.ts";
import { MAX_FILE_BYTES, MAX_FILE_LABEL } from "../shared/protocol.ts";

test("byte counts read the way a person would say them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1024.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(150_323_855), "143.4 MB");
});

test("the file size limit and its label agree", () => {
  // The label goes on the picker and into the rejection message; the constant
  // is what actually rejects. They are one number in two places.
  assert.equal(MAX_FILE_LABEL, "64 MB");
  assert.equal(formatBytes(MAX_FILE_BYTES), "64.0 MB");
});
