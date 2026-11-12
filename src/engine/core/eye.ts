/**
 * The clear view: how far the eye is lifted over what stands right around
 * the standpoint.
 *
 * A person looks over the kerb, the embankment and the boulder next to
 * them without thinking; an eye 1.7 m over one DEM post does not. With the
 * sightlines marched from the eye itself, a bank ten metres away hides
 * every summit behind it, in the picture and among the labels alike. And
 * the standpoint is only known to the accuracy of the fix: the bank may as
 * well be behind you.
 *
 * So the ground around the standpoint is taken as a whole: a plane is
 * fitted through the terrain in a disc as wide as the standpoint is
 * uncertain, and the eye is lifted until it stands as high over the highest
 * point of the disc, measured from that plane, as it stood over its own
 * spot. An even slope has nothing above its plane and lifts nothing: looking
 * uphill there really is nothing to see. A bank or a step of the DEM does.
 * Standing on the highest point, a knoll or a crest, lifts nothing either.
 */

export const CLEAR_VIEW = {
  /** Radius of the disc, metres: the accuracy of the fix, within these; `radius` when none is known. */
  minRadius: 15,
  maxRadius: 50,
  radius: 30,
  /**
   * A lift below this is the DEM's own roughness: none. Heights are whole
   * metres, so on any slope the highest post of the disc stands up to half
   * a metre over the plane and the standpoint up to half a metre under it.
   */
  deadBand: 1.5,
  /** The most the eye is lifted, metres: at the foot of a wall it does not go up the wall. */
  cap: 10,
};

/** The radius of the disc for a fix of this accuracy (metres), or for a standpoint without one. */
export function fitRadius(accuracy: number | null | undefined): number {
  if (accuracy == null || !Number.isFinite(accuracy)) return CLEAR_VIEW.radius;
  return Math.min(CLEAR_VIEW.maxRadius, Math.max(CLEAR_VIEW.minRadius, accuracy));
}

/**
 * How far to lift the eye, metres. `height(east, north)` is the terrain
 * around the standpoint in metres from it; it is read on a grid `step`
 * metres wide inside `radius`.
 */
export function clearView(
  height: (east: number, north: number) => number, radius: number, step: number,
): { lift: number } {
  const n = Math.max(1, Math.floor(radius / step));
  // The grid is symmetric about the standpoint, so the least-squares plane
  // comes apart: its level is the mean, each slope its own sum.
  let count = 0, sum = 0, sxx = 0, sxh = 0, syh = 0;
  const pts: number[] = [];
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const x = i * step, y = j * step;
      if (x * x + y * y > radius * radius) continue;
      const h = height(x, y);
      pts.push(x, y, h);
      count++; sum += h; sxx += x * x; sxh += x * h; syh += y * h;
    }
  }
  const level = sum / count, bx = sxx > 0 ? sxh / sxx : 0, by = sxx > 0 ? syh / sxx : 0;
  let top = -Infinity, own = 0;
  for (let k = 0; k < pts.length; k += 3) {
    const over = pts[k + 2] - (level + bx * pts[k] + by * pts[k + 1]);
    if (over > top) top = over;
    if (pts[k] === 0 && pts[k + 1] === 0) own = over;
  }
  const lift = top - own;
  if (!(lift >= CLEAR_VIEW.deadBand)) return { lift: 0 };
  return { lift: Math.min(CLEAR_VIEW.cap, lift) };
}
