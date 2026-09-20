/**
 * The synthetic test range: a closed-form terrain the E2E tests render and
 * reason about. Everything a test expects on screen is *computed* from these
 * functions, never read off a picture.
 *
 * The standpoint is on a flat plain at 1500 m. Due east, 5 km away, stands the
 * Testhorn, a cone 4000 m high; due north, 20 km away, a long east-west ridge
 * at 2600 m; everything else is the plain with a gentle deterministic ripple
 * so that shading has something to show.
 */

export const STAND = { lon: 10.0, lat: 47.0 };
export const PLAIN_M = 1500;
export const TESTHORN = { lon: 10.0 + 5000 / (111320 * Math.cos(47 * Math.PI / 180)), lat: 47.0, summit: 4000, radius: 2500 };
export const RIDGE = { lat: 47.0 + 20000 / 111320, height: 2600, halfWidth: 800 };

const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos(STAND.lat * Math.PI / 180);

/** Height in metres at a geodetic point. */
export function heightAt(lon: number, lat: number): number {
  const dxT = (lon - TESTHORN.lon) * M_PER_DEG_LON;
  const dyT = (lat - TESTHORN.lat) * M_PER_DEG_LAT;
  const rT = Math.hypot(dxT, dyT);
  const cone = Math.max(0, 1 - rT / TESTHORN.radius) * (TESTHORN.summit - PLAIN_M);
  const dyR = Math.abs(lat - RIDGE.lat) * M_PER_DEG_LAT;
  const ridge = Math.max(0, 1 - dyR / RIDGE.halfWidth) * (RIDGE.height - PLAIN_M);
  const ripple = 8 * Math.sin((lon - STAND.lon) * M_PER_DEG_LON / 400) * Math.cos((lat - STAND.lat) * M_PER_DEG_LAT / 400);
  return PLAIN_M + Math.max(cone, ridge) + ripple;
}

/** Bearing from the standpoint to the Testhorn summit, degrees. */
export const TESTHORN_BEARING = 90;
/** Ground range to the Testhorn summit, metres. */
export const TESTHORN_RANGE = 5000;

/**
 * Where the Testhorn's summit lands on screen, as a fraction of the height
 * from the top, for a camera at eye altitude `eye` looking level (pitch 0)
 * straight at it with vertical field of view `fov`. Curvature at 5 km is
 * under 2 m and refraction less, so both are ignored.
 */
export function summitScreenY(eye: number, fov: number): number {
  const elev = Math.atan2(TESTHORN.summit - eye, TESTHORN_RANGE);
  const tanHalf = Math.tan((fov * Math.PI / 180) / 2);
  return 0.5 - 0.5 * (Math.tan(elev) / tanHalf);
}
