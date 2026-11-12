/**
 * The resolution a frame is rendered at. Three passes run per pixel, so the
 * fragment load goes with the square of the device pixel ratio: a phone
 * screen with a ratio of 3 costs nine times a ratio of 1, and what it buys
 * beyond about 1.5 is not visible in a picture of lines and soft shading.
 */

/** Most device pixels per CSS pixel, by rendering quality. */
export const PIXEL_RATIO_CAP = { low: 1.5, high: 2 };

/** Device pixels per CSS pixel to render at: the screen's ratio, at most `cap`. */
export function renderPixelRatio(devicePixelRatio: number, cap: number): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, cap);
}
