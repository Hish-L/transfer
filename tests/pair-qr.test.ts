import assert from "node:assert/strict";
import test from "node:test";
import { siblingUrl } from "../shared/pair-qr.ts";

// The pairing QR is only useful if the URL inside it is the one the other
// device should open. The deploy prefix is the part that gets lost: the app
// lives under /transfer/ on Pages, at the root on a custom domain, and on an
// arbitrary port in dev.
test("a sibling page keeps the deploy prefix", () => {
  const base = "https://hish-l.github.io/transfer";
  assert.equal(siblingUrl(`${base}/send/`, "../receive/"), `${base}/receive/`);
  assert.equal(siblingUrl(`${base}/receive/`, "../send/"), `${base}/send/`);
});

test("a missing trailing slash does not climb out of the deploy directory", () => {
  assert.equal(
    siblingUrl("https://hish-l.github.io/transfer/send", "../receive/"),
    "https://hish-l.github.io/transfer/receive/",
  );
});

test("an explicit index.html is treated as its directory", () => {
  assert.equal(
    siblingUrl("https://hish-l.github.io/transfer/send/index.html", "../receive/"),
    "https://hish-l.github.io/transfer/receive/",
  );
});

test("query and hash are dropped rather than carried across", () => {
  assert.equal(
    siblingUrl("https://example.com/send/?debug=1#top", "../receive/"),
    "https://example.com/receive/",
  );
});

test("a root deploy, a custom port and a bare host all resolve", () => {
  assert.equal(siblingUrl("https://flight.example/send/", "../receive/"), "https://flight.example/receive/");
  assert.equal(siblingUrl("https://192.168.1.42:5173/send/", "../receive/"), "https://192.168.1.42:5173/receive/");
});
