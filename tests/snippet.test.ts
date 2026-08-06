import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SNIPPET_BYTES,
  MAX_SNIPPET_LABEL,
  isSnippet,
  packSnippet,
  snippetText,
} from "../shared/snippet.ts";
import { unpackFile, verifyFile } from "../shared/protocol.ts";

test("a text snippet survives the optical container", async () => {
  const text = "ssh-ed25519 AAAAC3Nz… evan@laptop\nand a second line.";
  const packed = await packSnippet(text);
  const file = await unpackFile(packed.container);

  assert.ok(await verifyFile(file));
  assert.ok(isSnippet(file));
  assert.equal(snippetText(file), text);
});

test("the receiver tells a snippet apart from an ordinary file", async () => {
  const { packFile } = await import("../shared/protocol.ts");
  const file = await unpackFile(
    (await packFile("notes.txt", "text/plain", new TextEncoder().encode("hello"))).container,
  );

  assert.equal(isSnippet(file), false);
  assert.throws(() => snippetText(file), /not a text snippet/);
});

test("empty snippets are rejected", async () => {
  await assert.rejects(() => packSnippet("  \n\t "), /Paste or type some text/);
});

test("snippets are capped, and the cap is measured in UTF-8 bytes", async () => {
  await assert.rejects(
    () => packSnippet("x".repeat(MAX_SNIPPET_BYTES + 1)),
    new RegExp(`limited to ${MAX_SNIPPET_LABEL}`),
  );

  // "あ" is one UTF-16 unit but three UTF-8 bytes, so a string well under the
  // cap by .length is still over it on the wire.
  await assert.rejects(
    () => packSnippet("あ".repeat(Math.ceil(MAX_SNIPPET_BYTES / 3) + 1)),
    new RegExp(`limited to ${MAX_SNIPPET_LABEL}`),
  );
});

test("long snippets compress before they are transmitted", async () => {
  const packed = await packSnippet("the same sentence over and over. ".repeat(2000));

  assert.equal(packed.compression, "gzip");
  assert.ok(packed.transmittedSize < packed.originalSize);
});
