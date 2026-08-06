import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SOURCE_BLOCKS,
  blockLength,
  fitsInOneStream,
  minimumFrameBytes,
  smallestSufficientFrameSize,
  sourceBlockCount,
} from "../shared/frame-capacity.ts";
import { HEADER_LEN, MAX_FILE_BYTES } from "../shared/protocol.ts";
import { FRAME_BYTES_OPTIONS } from "../shared/send-settings.ts";

/** The sender's actual bytes/frame dropdown — these tests hold for the options
 *  really on offer, not a copy that can drift. */
const OFFERED = FRAME_BYTES_OPTIONS;

test("the header takes its cut off every frame", () => {
  assert.equal(blockLength(2953), 2953 - HEADER_LEN);
  assert.equal(blockLength(500), 480);
});

test("block count rounds up, because a partial block still needs a frame", () => {
  assert.equal(sourceBlockCount(1, 2953), 1);
  assert.equal(sourceBlockCount(2933, 2953), 1);
  assert.equal(sourceBlockCount(2934, 2953), 2);
  assert.equal(sourceBlockCount(10 * 2933, 2953), 10);
});

test("the block ceiling bites well below the file size limit", () => {
  // This is the whole reason the check exists: at the smallest offered frame
  // size you run out of block numbers around 30 MB, not 64.
  assert.equal(fitsInOneStream(30 * 1024 * 1024, 500), false);
  assert.equal(fitsInOneStream(20 * 1024 * 1024, 500), true);
  assert.equal(fitsInOneStream(MAX_FILE_BYTES, 2953), true);
});

test("minimumFrameBytes is the smallest frame size that actually fits", () => {
  for (const payload of [1, 1000, 30 * 1024 * 1024, 64 * 1024 * 1024, MAX_FILE_BYTES]) {
    const minimum = minimumFrameBytes(payload);
    assert.ok(fitsInOneStream(payload, minimum), `${payload} does not fit at ${minimum}`);
    // ...and it really is the smallest: one byte less must not fit, unless we
    // are already at the floor where a single block covers everything.
    if (sourceBlockCount(payload, minimum) > 1) {
      assert.equal(
        fitsInOneStream(payload, minimum - 1),
        false,
        `${payload} unexpectedly still fits at ${minimum - 1}`,
      );
    }
  }
});

test("the suggested dropdown option always works", () => {
  // The sender puts this number in front of the user, so it has to be a value
  // they can pick AND one that resolves the error.
  for (const payload of [30 * 1024 * 1024, 40 * 1024 * 1024, MAX_FILE_BYTES]) {
    for (const frameBytes of OFFERED) {
      if (fitsInOneStream(payload, frameBytes)) continue;
      const suggestion = smallestSufficientFrameSize(payload, OFFERED);
      assert.ok(suggestion !== undefined, `no suggestion for ${payload} at ${frameBytes}`);
      assert.ok(OFFERED.includes(suggestion), `${suggestion} is not an offered option`);
      assert.ok(fitsInOneStream(payload, suggestion), `${suggestion} still does not fit`);
      assert.ok(suggestion > frameBytes, "suggesting the setting that just failed helps nobody");
    }
  }
});

test("an offered option always exists for any legal payload", () => {
  // The container adds a header plus the name and media type, so allow room
  // above MAX_FILE_BYTES for the largest plausible envelope.
  const worstCase = MAX_FILE_BYTES + 49 + 2 * 0xffff;
  const suggestion = smallestSufficientFrameSize(worstCase, OFFERED);
  assert.ok(suggestion !== undefined, "the dropdown cannot express the largest legal payload");
  assert.ok(fitsInOneStream(worstCase, suggestion));
});

test("no suggestion when nothing on offer is big enough", () => {
  assert.equal(smallestSufficientFrameSize(MAX_SOURCE_BLOCKS * 4000, OFFERED), undefined);
});
