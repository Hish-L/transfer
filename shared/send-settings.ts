// The sender's transmit tuning, in one place. The dropdowns in send/index.html
// are rendered from these lists via the %TX_FPS_OPTIONS% / %FRAME_BYTES_OPTIONS%
// tokens (see htmlTokens() in vite.config.ts), and the receiver's no-signal
// hint names its fallback values from here too — so the advice can never point
// at a setting the sender doesn't offer.

/** What the no-signal hint tells the user to turn the sender down to. */
export const NO_SIGNAL_HINT_FRAME_BYTES = 1465;
export const NO_SIGNAL_HINT_TX_FPS = 24;

export const DEFAULT_TX_FPS = 60;
export const DEFAULT_FRAME_BYTES = 2953;

// The hint values appear in these lists by construction, not by coincidence.
export const TX_FPS_OPTIONS: readonly number[] = [10, 15, 20, NO_SIGNAL_HINT_TX_FPS, 30, DEFAULT_TX_FPS];
export const FRAME_BYTES_OPTIONS: readonly number[] = [
  500,
  1000,
  NO_SIGNAL_HINT_FRAME_BYTES,
  1850,
  2331,
  DEFAULT_FRAME_BYTES,
];

export type Ecc = "L" | "M" | "Q" | "H";
export const ECC_LEVELS: readonly Ecc[] = ["L", "M", "Q", "H"];

/**
 * Byte-mode capacity of a version-40 QR code at each error correction level.
 *
 * This is a hard ceiling on bytes / frame, not a guideline: V40 is the largest
 * code that exists, so a frame bigger than this cannot be encoded at that ECC
 * at any size. The two ceilings appear in FRAME_BYTES_OPTIONS above — the list
 * was written against L, which is why every larger option has to disappear
 * from the dropdown as the ECC goes up.
 */
export const MAX_FRAME_BYTES_BY_ECC: Readonly<Record<Ecc, number>> = {
  L: 2953,
  M: 2331,
  Q: 1663,
  H: 1273,
};

/** The largest offered frame size that can actually be encoded at this ECC. */
export function largestFrameBytesFor(ecc: Ecc): number {
  const cap = MAX_FRAME_BYTES_BY_ECC[ecc];
  return Math.max(...FRAME_BYTES_OPTIONS.filter((bytes) => bytes <= cap));
}
