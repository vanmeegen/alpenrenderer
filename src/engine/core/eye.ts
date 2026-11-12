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
 * What counts as standing in the way is decided direction by direction:
 * ground inside a disc as wide as the standpoint is uncertain that rises
 * above everything beyond the disc that way. The eye is lifted until, in
 * every direction, the far horizon shows over the near ground with a little
 * room. So a slope lifts nothing, however uneven: above each hump there is
 * more of the mountain. A terrace that goes on beyond the disc lifts
 * nothing: it is the terrain. A bank, the rim of a hollow, a step of the
 * DEM with open country behind do. (Fitting a plane to the disc and
 * standing over its highest point, the first attempt, put the eye 6.5 m up
 * on the Mauritzalm, a meadow at 20°: a ridge 400 m away then stood a
 * degree off in the camera view.)
 */

export const CLEAR_VIEW = {
  /** Radius of the disc, metres: the accuracy of the fix, within these; `radius` when none is known. */
  minRadius: 15,
  maxRadius: 50,
  radius: 30,
  /** Room between the sightline to the far horizon and the near ground it passes over, metres. */
  margin: 0.5,
  /** The most the eye is lifted, metres: at the foot of a wall it does not go up the wall. */
  cap: 10,
  /** Directions looked in. */
  bearings: 64,
};

/** The radius of the disc for a fix of this accuracy (metres), or for a standpoint without one. */
export function fitRadius(accuracy: number | null | undefined): number {
  if (accuracy == null || !Number.isFinite(accuracy)) return CLEAR_VIEW.radius;
  return Math.min(CLEAR_VIEW.maxRadius, Math.max(CLEAR_VIEW.minRadius, accuracy));
}

/**
 * How far to lift an eye at altitude `eye`, metres. `height(east, north)` is
 * the terrain around the standpoint in metres from it, read every `step`
 * metres out to `radius`; `far(bearing)` is the tangent of the highest
 * apparent elevation of all the ground beyond `radius` towards that bearing
 * (degrees), -Infinity where nothing is known of it.
 */
export function clearView(
  height: (east: number, north: number) => number,
  far: (bearing: number) => number,
  eye: number, radius: number, step: number,
): { lift: number } {
  let needed = -Infinity;
  for (let i = 0; i < CLEAR_VIEW.bearings; i++) {
    const bearing = (i * 360) / CLEAR_VIEW.bearings;
    const beyond = far(bearing);
    if (!Number.isFinite(beyond)) continue;
    const b = (bearing * Math.PI) / 180, sin = Math.sin(b), cos = Math.cos(b);
    // The sightline to the far horizon passes `r * beyond` above the eye at
    // range r; the eye has to stand so that the ground there is below it.
    for (let r = step; r <= radius; r += step) {
      const eyeFor = height(r * sin, r * cos) - r * beyond;
      if (eyeFor > needed) needed = eyeFor;
    }
  }
  const lift = needed + CLEAR_VIEW.margin - eye;
  if (!(lift > 0)) return { lift: 0 };
  return { lift: Math.min(CLEAR_VIEW.cap, lift) };
}
