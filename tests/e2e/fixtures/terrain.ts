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

/**
 * The summit catalogue of the range, as the cell file the app loads. The
 * Hinterhorn stands on the plain 12 km east, straight behind the Testhorn:
 * catalogued at 3500 m, but the DEM knows only the plain there, so it is
 * hidden and must never get a label.
 */
export const PEAKS = [
  { i: 1, n: 'Testhorn', o: TESTHORN.lon, a: TESTHORN.lat, e: TESTHORN.summit, p: 2500, w: 'Q1', k: 'de:Testhorn' },
  { i: 2, n: 'Gratspitze', o: STAND.lon, a: RIDGE.lat, e: RIDGE.height },
  { i: 3, n: 'Hinterhorn', o: STAND.lon + 12000 / M_PER_DEG_LON, a: STAND.lat, e: 3500 },
];
export const RIDGE_RANGE = 20000;

/** The eye stands this far above the highest ground within EYE_CLEAR_RADIUS metres. */
export const EYE_HEIGHT = 1.7;
export const EYE_CLEAR_RADIUS = 25;

/** A standpoint on the Testhorn's west flank, 1500 m from the summit: the cone rises 1 m per metre there. */
export const FLANK = { lon: TESTHORN.lon - 1500 / M_PER_DEG_LON, lat: TESTHORN.lat };

/**
 * How far above the ground under the standpoint the eye stands: EYE_HEIGHT
 * over the highest ground within EYE_CLEAR_RADIUS, so that on a slope the
 * eye is not inside the hill next to it. 1.7 m on flat ground.
 */
export function eyeAbove(lon: number, lat: number): number {
  const g = heightAt(lon, lat);
  let best = g;
  const r = EYE_CLEAR_RADIUS;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      best = Math.max(best, heightAt(lon + dx / M_PER_DEG_LON, lat + dy / M_PER_DEG_LAT));
    }
  }
  return best - g + EYE_HEIGHT;
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

const R_EFF = 6371008.8 / (1 - 0.13);   // the renderer's refracted earth radius

/** Height at a bearing and ground range from the standpoint, metres. */
export function heightAlong(bearingDeg: number, range: number): number {
  const b = (bearingDeg * Math.PI) / 180;
  const lon = STAND.lon + (range * Math.sin(b)) / M_PER_DEG_LON;
  const lat = STAND.lat + (range * Math.cos(b)) / M_PER_DEG_LAT;
  return heightAt(lon, lat);
}

/**
 * The skyline in one screen column, as a row from the top: the highest
 * apparent elevation along the sightline at that column's bearing (a DEM
 * march with the renderer's curvature and refraction), projected with the
 * camera's perspective. This is the reference the rendered range buffer is
 * held against.
 */
export function skylineRow(yawDeg: number, x: number, eye: number, fov: number, width: number, height: number): number {
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * (width / height);
  const ndcX = (x + 0.5) / width * 2 - 1;
  const b = Math.atan(ndcX * tanH);                       // azimuth offset of the column
  const bearing = yawDeg + (b * 180) / Math.PI;
  let maxTan = -Infinity;
  const steps = 6000, r0 = 1, r1 = 275000;
  const k = Math.log(r1 / r0) / (steps - 1);
  for (let i = 0; i < steps; i++) {
    const r = r0 * Math.exp(i * k);
    const up = heightAlong(bearing, r) - eye - (r * r) / (2 * R_EFF);
    maxTan = Math.max(maxTan, up / r);
  }
  return height / 2 - (height / 2) * (maxTan / Math.cos(b)) / tanV;
}

/**
 * Where the view ray through screen pixel (x, y) meets the terrain, for a
 * level camera at `eye` metres looking along `yawDeg`: the point's position,
 * height, ground range and outward unit normal (east, north, up) from the
 * formula's own gradient. Curvature is ignored: under 2 m at the 5 km the
 * shading test looks at.
 */
export function terrainHit(yawDeg: number, x: number, y: number, eye: number, fov: number, width: number, height: number) {
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * (width / height);
  const ndcX = ((x + 0.5) / width) * 2 - 1;
  const ndcY = 1 - ((y + 0.5) / height) * 2;
  const b = Math.atan(ndcX * tanH);
  const bearing = yawDeg + (b * 180) / Math.PI;
  const rise = (ndcY * tanV) / Math.sqrt(1 + (ndcX * tanH) ** 2);   // height gained per metre of ground range
  let prev = 0;
  for (let r = 1; r < 50000; r += 1) {
    const ground = heightAlong(bearing, r);
    const ray = eye + r * rise;
    if (ray <= ground) {
      const rr = prev + (r - prev) * 0.5;
      const br = (bearing * Math.PI) / 180;
      const lon = STAND.lon + (rr * Math.sin(br)) / M_PER_DEG_LON;
      const lat = STAND.lat + (rr * Math.cos(br)) / M_PER_DEG_LAT;
      const d = 2;   // metres, for the gradient
      const dhE = (heightAt(lon + d / M_PER_DEG_LON, lat) - heightAt(lon - d / M_PER_DEG_LON, lat)) / (2 * d);
      const dhN = (heightAt(lon, lat + d / M_PER_DEG_LAT) - heightAt(lon, lat - d / M_PER_DEG_LAT)) / (2 * d);
      const len = Math.hypot(dhE, dhN, 1);
      return { lon, lat, h: heightAt(lon, lat), range: rr, normal: [-dhE / len, -dhN / len, 1 / len] as [number, number, number] };
    }
    prev = r;
  }
  return null;
}

/**
 * The fake camera frame: luma values (0..255, full range) of the light upper
 * and dark lower half. Grey only, so what the renderer samples does not
 * depend on the browser's YUV matrix.
 */
export const CAMERA_TOP_Y = 204;
export const CAMERA_BOTTOM_Y = 51;
export const CAMERA_FRAME = { width: 640, height: 480 };

/**
 * The fixture photo: taken from the standpoint, pointed a little right of the
 * Testhorn, slightly up, level, with a 26 mm-equivalent lens. The EXIF in the
 * file carries the standpoint and the lens; the pose is what alignment must
 * recover.
 */
export const PHOTO = {
  width: 640, height: 480, yaw: 94, pitch: 8, roll: 0, focal35: 26,
  taken: '2026:09:20 11:30:00',
  /** Vertical field of view of that lens on this 4:3 frame, degrees: the long side is the 36 mm of the equivalent, the short side 27 mm. */
  fovY: (2 * Math.atan(13.5 / 26) * 180) / Math.PI,
};
