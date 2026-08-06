export function fitQrDisplaySize(
  viewportWidth: number,
  viewportHeight: number,
  containerWidth: number,
  requestedSize: number,
  horizontalChrome = 0,
  verticalChrome = 0,
): number {
  // The 0.9 is a blind edge allowance for a code sitting in page flow. A caller
  // that can actually measure what shares the viewport with it — the sender's
  // stream modal, which stacks metrics and buttons underneath — passes that
  // measurement instead and gets the honest remainder, rather than paying the
  // allowance twice and rendering smaller than it needs to.
  const heightBudget = verticalChrome > 0 ? viewportHeight - verticalChrome : 0.9 * viewportHeight;
  const viewportBudget = Math.min(0.9 * viewportWidth, heightBudget);
  const containerBudget = Math.max(1, containerWidth - horizontalChrome);
  return Math.max(1, Math.min(viewportBudget, containerBudget, requestedSize));
}
