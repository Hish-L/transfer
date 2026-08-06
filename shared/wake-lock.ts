/** Keep the screen awake for the duration of a transfer, best effort — a
 *  sender that sleeps mid-stream kills the transfer, but a browser without
 *  the API (or a denied request) is fine to run without it. */
export async function requestScreenWakeLock(): Promise<void> {
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine without it */
  }
}
