// How much payload fits in a stream at a given frame size.
//
// The frame header numbers source blocks in a u16, so a large payload at a
// small bytes-per-frame runs out of block numbers long before it runs out of
// the file size limit: at 500 bytes per frame the real ceiling is about 30 MB,
// not 64. The sender has to catch that before it starts streaming, and tell
// you which setting fixes it.

import { HEADER_LEN } from "./protocol";

/** `k` is a u16 in the frame header. */
export const MAX_SOURCE_BLOCKS = 0xffff;

/** Payload bytes per frame, once the header has taken its cut. */
export function blockLength(frameBytes: number): number {
  return frameBytes - HEADER_LEN;
}

/** Source blocks a payload splits into at this frame size. */
export function sourceBlockCount(payloadBytes: number, frameBytes: number): number {
  return Math.ceil(payloadBytes / blockLength(frameBytes));
}

export function fitsInOneStream(payloadBytes: number, frameBytes: number): boolean {
  return sourceBlockCount(payloadBytes, frameBytes) <= MAX_SOURCE_BLOCKS;
}

/** The smallest bytes-per-frame that can carry this payload at all. */
export function minimumFrameBytes(payloadBytes: number): number {
  return Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) + HEADER_LEN;
}

/**
 * The smallest offered setting that works, so the sender can name a value that
 * is actually in the dropdown instead of the bare arithmetic minimum.
 *
 * Undefined when no option is large enough — unreachable while MAX_FILE_BYTES
 * holds, since the largest legal payload needs about 1045 bytes per frame, but
 * the caller should not have to know that.
 */
export function smallestSufficientFrameSize(
  payloadBytes: number,
  options: readonly number[],
): number | undefined {
  const minimum = minimumFrameBytes(payloadBytes);
  return options
    .filter((value) => value >= minimum)
    .sort((a, b) => a - b)[0];
}
