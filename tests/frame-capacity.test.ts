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
import {
  ECC_LEVELS,
  FRAME_BYTES_OPTIONS,
  MAX_FRAME_BYTES_BY_ECC,
  largestFrameBytesFor,
} from "../shared/send-settings.ts";
import QRCode from "qrcode";

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

/** Encode `bytes` of byte-mode payload at this ECC, unpinned version. */
const encodes = (bytes: number, ecc: string): boolean => {
  try {
    QRCode.create([{ data: new Uint8Array(bytes), mode: "byte" } as never], {
      errorCorrectionLevel: ecc as "L",
      maskPattern: 4,
    });
    return true;
  } catch {
    return false;
  }
};

test("the per-ECC ceiling is exactly what the encoder will take", () => {
  // Asserted against the real encoder, not transcribed from a table: these
  // numbers decide which options the sender is allowed to offer, and a wrong
  // one either hides a usable frame size or offers one that cannot encode.
  for (const ecc of ECC_LEVELS) {
    const cap = MAX_FRAME_BYTES_BY_ECC[ecc];
    assert.ok(encodes(cap, ecc), `ECC ${ecc} should encode ${cap} bytes`);
    assert.ok(!encodes(cap + 1, ecc), `ECC ${ecc} should not encode ${cap + 1} bytes`);
  }
});

test("every ECC keeps at least one usable frame size, and it encodes", () => {
  // The bug this guards: the dropdown was written against L, whose ceiling is
  // the largest option, so raising the ECC offered frame sizes that no QR
  // version can hold and the stream died on its first frame.
  for (const ecc of ECC_LEVELS) {
    const largest = largestFrameBytesFor(ecc);
    assert.ok(OFFERED.includes(largest), `${largest} is not an offered option`);
    assert.ok(largest <= MAX_FRAME_BYTES_BY_ECC[ecc]);
    assert.ok(encodes(largest, ecc), `ECC ${ecc} cannot encode its own largest option`);
  }
});

test("every offered frame size encodes at the ECC levels that allow it", () => {
  for (const ecc of ECC_LEVELS) {
    for (const frameBytes of OFFERED) {
      assert.equal(
        encodes(frameBytes, ecc),
        frameBytes <= MAX_FRAME_BYTES_BY_ECC[ecc],
        `ECC ${ecc} at ${frameBytes} bytes disagrees with the ceiling`,
      );
    }
  }
});
