/**
 * The shading formula, once, in TypeScript: what the shade pass in wgsl.ts
 * and glsl.ts draws, written out so a test can compute the colour a pixel
 * must have from the terrain alone. The shaders are the same formula in
 * their own dialect and must stay so.
 *
 * The look is the one from the Zugspitze spike: a hypsometric tint, rock
 * where it is steep, snow where it is high and not too steep, a plain
 * Lambert light from the south-south-east with a dark floor so shadow sides
 * keep their shape, and aerial perspective toward the horizon colour.
 */

/** Sun direction, degrees: bearing it stands at, and height above the horizon. */
export const SUN = { azimuth: 160, elevation: 45 };
/** Metres: full snow above, none 350 m below. */
export const SNOW_LINE = 2900;
/** Metres to 1/e of the terrain colour. */
export const FOG_RANGE = 55000;
export const HORIZON_COLOR: [number, number, number] = [0.80, 0.87, 0.95];
/** Lakes: a mountain-lake blue, lit and hazed like the ground around it. */
export const WATER_COLOR: [number, number, number] = [0.17, 0.33, 0.50];
/**
 * A little shine on the water, cheap enough for a 200-euro phone: no second
 * pass for real reflections, only what the view vector gives. Schlick's
 * Fresnel with the reflectance of water (f0) pulls the lake toward the sky
 * at grazing angles, capped at `sky` so it stays a lake; the sun's mirror
 * image is a soft glint of strength `glint`, `sharpness` its Phong power.
 */
export const WATER_SHINE = { f0: 0.02, sky: 0.6, glint: 0.35, sharpness: 60 };

const DEG = Math.PI / 180;

/** Unit vector toward the sun, east-north-up. */
export function sunVector(): [number, number, number] {
  const az = SUN.azimuth * DEG, el = SUN.elevation * DEG;
  return [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
}

/** Lambert with a floor: 0.28 in full shadow, 1 facing the sun. */
export function shadeFactor(diff: number): number {
  return 0.28 + 0.72 * Math.max(0, diff);
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Sky reflection and sun glint on lit water, `view` the unit vector from the
 * eye to the point (east, north, up). The water is taken as flat: lakes are.
 */
export function waterShine(col: [number, number, number], view: [number, number, number]): [number, number, number] {
  const cosI = Math.max(0, -view[2]);
  const fresnel = WATER_SHINE.f0 + (1 - WATER_SHINE.f0) * (1 - cosI) ** 5;
  let out = mix(col, HORIZON_COLOR, fresnel * WATER_SHINE.sky);
  const s = sunVector();
  const mirrored = view[0] * s[0] + view[1] * s[1] - view[2] * s[2];
  const glint = WATER_SHINE.glint * Math.max(0, mirrored) ** WATER_SHINE.sharpness;
  out = [Math.min(1, out[0] + glint), Math.min(1, out[1] + glint), Math.min(1, out[2] + glint)];
  return out;
}

/**
 * Linear RGB of a terrain pixel at altitude `h` metres, with the surface
 * normal `n` (east, north, up; unit) and ground range `range` metres;
 * `water` where the lake mask marks the post, and with `view` (unit, eye to
 * point) the water shines.
 */
export function terrainColor(
  h: number, n: [number, number, number], range: number, water = false, view?: [number, number, number],
): [number, number, number] {
  const slope = 1 - n[2];
  const valley: [number, number, number] = [0.47, 0.60, 0.33];
  const forest: [number, number, number] = [0.28, 0.43, 0.24];
  const meadow: [number, number, number] = [0.58, 0.60, 0.38];
  const rock: [number, number, number] = [0.52, 0.50, 0.47];
  const snow: [number, number, number] = [0.94, 0.96, 0.99];
  let col = mix(valley, forest, smoothstep(700, 1100, h));
  col = mix(col, meadow, smoothstep(1500, 1900, h));
  col = mix(col, rock, smoothstep(1950, 2350, h));
  col = mix(col, rock, smoothstep(0.35, 0.6, slope) * 0.85);
  const snowy = smoothstep(SNOW_LINE - 350, SNOW_LINE + 50, h) * (1 - smoothstep(0.45, 0.7, slope));
  col = mix(col, snow, snowy);
  if (water) col = [...WATER_COLOR];
  const s = sunVector();
  const diff = n[0] * s[0] + n[1] * s[1] + n[2] * s[2];
  const shade = shadeFactor(diff);
  col = [col[0] * shade, col[1] * shade, col[2] * shade];
  if (water && view) col = waterShine(col, view);
  const fog = 1 - Math.exp(-range / FOG_RANGE);
  return mix(col, HORIZON_COLOR, fog * 0.88);
}

/** Rec. 709 luminance of linear RGB, as the E2E tests measure it. */
export const luminance = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
