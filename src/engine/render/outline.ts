/**
 * The ink line and the haze rim, once, in TypeScript: what the composite
 * pass in glsl.ts and wgsl.ts draws from the range buffer, written out so a
 * test can compute it. The constants are injected into both dialects.
 *
 * Both work on the logarithm of the ground range, the form the range pass
 * stores: a ridge 10 % behind another is the same step of 0.095 whether the
 * pair is 2 km or 80 km away.
 *
 * The line. On each of four axes through the pixel, `a` and `b` are the
 * range steps to the two neighbours a line width away. Their sum is the
 * second difference: positive where the pixel is nearer than its
 * surroundings, which is the near side of a silhouette, so the line is
 * drawn on the mountain in front and never twice. An even surface seen at a
 * grazing angle has a second difference too (the range grows faster and
 * faster towards the horizon), but it comes with a first step on both sides;
 * a silhouette has a step on one side only. Taking `kappa` times the smaller
 * step off removes the grazing ground and leaves the silhouette.
 *
 * The rim. Painters of panoramas (Berann) set a light haze behind every
 * ridge so that the layers come apart. A pixel gets it when neighbours a few
 * pixels away are nearer than its own surface, continued at its own slope,
 * would be there: it lies just behind something in front. On an even
 * surface the continuation never overshoots, so there is no rim. Each of
 * the eight neighbours counts once, however much nearer it is, and half of
 * them make the full rim: so it fades with the distance from the ridge, and
 * a meadow edge a hundred metres away glares no more than a ridge in front
 * of the next.
 */

export const OUTLINE = {
  /** Step of log range where the line begins and where it is full: a 2 % and a 6 % jump in range. */
  silLow: 0.02,
  silHigh: 0.06,
  /** Share of the smaller one-sided step taken off, against grazing ground. */
  kappa: 0.5,
  /** Line width in CSS pixels, far away and close by, and the log ranges between which it grows (800 m, 25 km). */
  widthFar: 1.0,
  widthNear: 2.5,
  logNear: Math.log(800),
  logFar: Math.log(25000),
  /** The ink: a dark blue-grey, mixed in rather than multiplied, so it reads on dark forest as on snow. */
  ink: [0.10, 0.12, 0.17] as [number, number, number],
  /** How far a distant line pales into the haze, the range in metres to 1/e of that, and its strength far away. */
  inkHaze: 0.6,
  inkFog: 55000,
  strengthFar: 0.75,
  /**
   * The rim: radius in CSS pixels; how much nearer (log range) a neighbour
   * must be to begin to count and to count fully (3 % and 28 %); how many of
   * the eight make the full rim; its strength, and its share on sky.
   */
  rimRadius: 6,
  rimLow: 0.03,
  rimHigh: 0.25,
  rimTaps: 4,
  rim: 0.32,
  rimSky: 0.35,
  /** What a pixel with nothing drawn reads as: beyond the far plane, so the skyline is an edge too. */
  logSky: 13.5,
};

/** Log of the ground range at a pixel (x right, y down, pixel centres at .5); OUTLINE.logSky where nothing is drawn. */
export type LogField = (x: number, y: number) => number;

const S = Math.SQRT1_2;
/** Four axes of an eight-point ring. */
export const RING_AXES: [number, number][] = [[1, 0], [0, 1], [S, S], [S, -S]];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 1 close by, 0 far away. */
export function nearness(logRange: number): number {
  return 1 - smoothstep(OUTLINE.logNear, OUTLINE.logFar, logRange);
}

/** Width of the line in CSS pixels for a surface at this log range. */
export function lineWidth(logRange: number): number {
  return OUTLINE.widthFar + (OUTLINE.widthNear - OUTLINE.widthFar) * nearness(logRange);
}

/** Coverage of the ink line at a pixel, 0..1; `scale` is device pixels per CSS pixel. */
export function edgeAt(L: LogField, x: number, y: number, scale = 1): number {
  const lc = L(x, y);
  const w = lineWidth(lc) * scale;
  let cover = 0;
  for (const [dx, dy] of RING_AXES) {
    const a = L(x + dx * w, y + dy * w) - lc;
    const b = L(x - dx * w, y - dy * w) - lc;
    cover += smoothstep(OUTLINE.silLow, OUTLINE.silHigh, a + b - OUTLINE.kappa * Math.min(Math.abs(a), Math.abs(b)));
  }
  return Math.min(1, Math.max(0, cover / 2));
}

/** Strength of the haze rim at a pixel, 0..OUTLINE.rim; `scale` is device pixels per CSS pixel. */
export function rimAt(L: LogField, x: number, y: number, scale = 1): number {
  const lc = L(x, y);
  const w = lineWidth(lc) * scale;
  // The surface's own slope in log range per pixel: the flatter of the two one-sided differences on each axis.
  const ax = L(x + w, y) - lc, bx = L(x - w, y) - lc;
  const ay = L(x, y + w) - lc, by = L(x, y - w) - lc;
  const gx = (Math.abs(ax) < Math.abs(bx) ? ax : -bx) / w;
  const gy = (Math.abs(ay) < Math.abs(by) ? ay : -by) / w;
  const R = OUTLINE.rimRadius * scale;
  let inFront = 0;
  for (const [dx, dy] of RING_AXES) {
    for (const sgn of [1, -1]) {
      const ex = sgn * dx, ey = sgn * dy;
      const rho = L(x + ex * R, y + ey * R) - (lc + R * (gx * ex + gy * ey));
      inFront += smoothstep(OUTLINE.rimLow, OUTLINE.rimHigh, -rho);
    }
  }
  const rim = OUTLINE.rim * Math.min(1, inFront / OUTLINE.rimTaps);
  return lc >= OUTLINE.logSky ? rim * OUTLINE.rimSky : rim;
}
