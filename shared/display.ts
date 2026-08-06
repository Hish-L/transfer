export function fitQrDisplaySize(
  viewportWidth: number,
  viewportHeight: number,
  containerWidth: number,
  requestedSize: number,
  horizontalChrome = 0,
): number {
  const viewportBudget = 0.9 * Math.min(viewportWidth, viewportHeight);
  const containerBudget = Math.max(1, containerWidth - horizontalChrome);
  return Math.max(1, Math.min(viewportBudget, containerBudget, requestedSize));
}
