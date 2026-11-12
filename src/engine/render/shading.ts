/**
 * The shading formula, once, in TypeScript: what the shade pass in wgsl.ts
 * and glsl.ts draws, written out so a test can compute the colour a pixel
 * must have from the terrain alone. The shaders are the same formula in
 * their own dialect and must stay so.
 *
 * The look: a hypsometric tint, rock where it is steep, snow where it is
 * high and not too steep, a plain Lambert light over the viewer's left
 * shoulder with a dark floor so shadow sides keep their shape, and aerial
 * perspective: haze that lies in the valleys and turns the distance blue.
 */
import { SURFACE } from '../core/surface';
import { lit } from './detail';

/**
 * The light, degrees: 45° up and `behind` degrees from the view direction,
 * over the viewer's left shoulder (yaw − 135°). Imhof's rule for relief
 * shading, light from the upper left, turned with the view: the slopes you
 * look at are lit, those facing right are in shadow, whichever way you turn,
 * so the relief reads the same everywhere. A sun fixed in the south-east lit
 * the view one way and left it flat the other; the real sun by the clock
 * stays an option.
 */
export const SUN = { elevation: 45, behind: 135 };
/** Metres: full snow above, none 350 m below. */
export const SNOW_LINE = 2900;
/**
 * The air. Its density falls off with altitude as e^(-z/height), so haze
 * lies in the valleys and the summits stand clear of it; `range` is the
 * distance in metres to 1/e of a colour in air of sea-level density (at
 * 2000 m that is 55 km). Blue is scattered out first (`beta` per channel),
 * which is what turns distant ridges blue; and no colour goes below `floor`
 * of itself, so the farthest ridge is still a ridge and not sky.
 */
export const FOG = { range: 28000, height: 3000, beta: [1, 1.12, 1.35] as [number, number, number], floor: 0.12 };
/** Metres to 1/e of the terrain colour at sea-level air density; the renderer's default for its fogRange. */
export const FOG_RANGE = FOG.range;
/**
 * Where the ground turns to rock and where snow no longer holds, as
 * `slope` = 1 − cos(angle): rock from 33° to 45° (weaker below the tree
 * line, where steep ground is forest as often as crag), snow gone between
 * 40° and 50°.
 */
export const GROUND = { rockLow: 0.16, rockHigh: 0.30, rockBelow: 0.45, rockAbove: 0.92, rockFrom: 1200, rockTo: 1800, snowLow: 0.23, snowHigh: 0.36 };
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

/**
 * Land cover (sources/landcover.ts): the classes of ESA WorldCover in the
 * order of their index in the tiles, 0 for none, and what each looks like.
 * Where a survey says what the ground is, its colour replaces the tint the
 * height alone would give; rock on steep ground and snow up high are laid
 * over it as before. Grass turns from valley green to the paler alpine
 * meadow between `grassFrom` and `grassTo` metres. `jitter` is how far, in
 * metres per unit of the grain's slope (detail.ts), the place a class is
 * read at is moved: it frays the 106 m steps of the cover's pixels.
 * `snowOnLand` is the share of the height's snow that ground of any class
 * but ice keeps above the snow line: the survey is a summer's, and what it
 * calls rock up there is rock with old snow in it, not a snowfield.
 */
export const COVER_CLASSES = ['none', 'tree', 'shrub', 'grass', 'crop', 'built', 'bare', 'snow', 'water', 'wetland', 'mangrove', 'moss'] as const;
type RGB = [number, number, number];
export const COVER = {
  tree: [0.2, 0.35, 0.2] as RGB,
  shrub: [0.4, 0.48, 0.28] as RGB,
  grassLow: [0.47, 0.62, 0.31] as RGB,
  grassHigh: [0.6, 0.61, 0.38] as RGB,
  grassFrom: 1400,
  grassTo: 2100,
  crop: [0.66, 0.65, 0.39] as RGB,
  built: [0.62, 0.59, 0.56] as RGB,
  bare: [0.52, 0.5, 0.47] as RGB,
  snow: [0.9, 0.94, 0.98] as RGB,
  wetland: [0.36, 0.46, 0.32] as RGB,
  moss: [0.55, 0.57, 0.45] as RGB,
  jitter: 50,
  snowOnLand: 0.3,
};

const DEG = Math.PI / 180;

/** Bearing of the light for a view direction `yaw`, degrees 0..360. */
export function sunAzimuth(yaw: number): number {
  return ((yaw - SUN.behind) % 360 + 360) % 360;
}

/** Unit vector toward the light, east-north-up, for a view direction `yaw` (degrees). */
export function sunVector(yaw = 0): [number, number, number] {
  const az = sunAzimuth(yaw) * DEG, el = SUN.elevation * DEG;
  return [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
}

/**
 * Lambert with a floor: 0.28 in full shadow, 1 facing the sun; times what
 * the ground around the point leaves of the sky (core/surface.ts): a hole
 * (`occlusion` 0) is darker by SURFACE.strength, a point (1) lighter by as
 * much, even ground (0.5) as lit.
 */
export function shadeFactor(diff: number, occlusion = 0.5): number {
  return (0.28 + 0.72 * Math.max(0, diff)) * (1 + SURFACE.strength * (2 * occlusion - 1));
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
export function waterShine(col: [number, number, number], view: [number, number, number], yaw = 0): [number, number, number] {
  const cosI = Math.max(0, -view[2]);
  const fresnel = WATER_SHINE.f0 + (1 - WATER_SHINE.f0) * (1 - cosI) ** 5;
  let out = mix(col, HORIZON_COLOR, fresnel * WATER_SHINE.sky);
  const s = sunVector(yaw);
  const mirrored = view[0] * s[0] + view[1] * s[1] - view[2] * s[2];
  const glint = WATER_SHINE.glint * Math.max(0, mirrored) ** WATER_SHINE.sharpness;
  out = [Math.min(1, out[0] + glint), Math.min(1, out[1] + glint), Math.min(1, out[2] + glint)];
  return out;
}

/**
 * What is left of a colour after `range` metres of air between an eye at
 * `eyeAlt` and a point at `h` metres, per channel: the density integrated
 * along the sightline (closed form for an exponential atmosphere), blue
 * fading fastest, never below FOG.floor. `fogRange` is the renderer's knob.
 */
export function transmittance(range: number, h: number, eyeAlt: number, fogRange = FOG.range): [number, number, number] {
  const H = FOG.height, dz = (h - eyeAlt) / H;
  const density = Math.abs(dz) < 1e-3 ? Math.exp(-eyeAlt / H) : (Math.exp(-eyeAlt / H) - Math.exp(-h / H)) / dz;
  const tau = (range / fogRange) * density;
  return FOG.beta.map((b) => Math.max(FOG.floor, Math.exp(-tau * b))) as [number, number, number];
}

/** A lit colour seen through the air: towards the horizon colour by what the air takes. */
export function haze(col: [number, number, number], range: number, h: number, eyeAlt: number, fogRange = FOG.range): [number, number, number] {
  const t = transmittance(range, h, eyeAlt, fogRange);
  return [0, 1, 2].map((i) => HORIZON_COLOR[i] + (col[i] - HORIZON_COLOR[i]) * t[i]) as [number, number, number];
}

/** The ground's own colour for a land cover class at `h` metres; `none` (the height's tint) where there is no class. */
export function coverColor(cls: number, h: number, none: RGB): RGB {
  switch (COVER_CLASSES[cls]) {
    case 'tree': case 'mangrove': return COVER.tree;
    case 'shrub': return COVER.shrub;
    case 'grass': return mix(COVER.grassLow, COVER.grassHigh, smoothstep(COVER.grassFrom, COVER.grassTo, h));
    case 'crop': return COVER.crop;
    case 'built': return COVER.built;
    case 'bare': return COVER.bare;
    case 'snow': return COVER.snow;
    case 'water': return WATER_COLOR;
    case 'wetland': return COVER.wetland;
    case 'moss': return COVER.moss;
    default: return none;
  }
}

/**
 * Where the class of a point is read: `metres` east and north of it, from
 * the slope channels of the grain's coarse and fine tile there (each −1..1,
 * detail.ts). Far out the sampler averages the grain away and nothing moves.
 */
export function coverJitter(coarse: RGB, fine: RGB): [number, number] {
  return [COVER.jitter * (coarse[0] + 0.5 * fine[0]), COVER.jitter * (coarse[1] + 0.5 * fine[1])];
}

/**
 * Linear RGB of a terrain pixel at altitude `h` metres, with the surface
 * normal `n` (east, north, up; unit) and ground range `range` metres;
 * `water` where the lake mask marks the post, and with `view` (unit, eye to
 * point) the water shines; `yaw` is the view direction the light turns
 * with; `eyeAlt` is where the eye stands, for the air in between (the
 * point's own height when not given); `occlusion` what core/surface.ts
 * gives for the point, 0.5 on even ground; `detail` the grain of the near
 * ground (detail.ts: `d` from detailAt, `fade` from detailFade), which
 * changes the light on dry ground and not what the ground is made of;
 * `cover` the land cover class there (COVER_CLASSES), 0 for none.
 */
export function terrainColor(
  h: number, n: [number, number, number], range: number, water = false, view?: [number, number, number], yaw = 0,
  eyeAlt = h, occlusion = 0.5, detail?: { d: [number, number, number]; fade: number }, cover = 0,
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
  col = coverColor(cover, h, col);
  const G = GROUND;
  const rocky = smoothstep(G.rockLow, G.rockHigh, slope)
    * (G.rockBelow + (G.rockAbove - G.rockBelow) * smoothstep(G.rockFrom, G.rockTo, h));
  col = mix(col, rock, rocky);
  const known = COVER_CLASSES[cover] !== undefined && cover !== 0 && COVER_CLASSES[cover] !== 'snow';
  const snowy = smoothstep(SNOW_LINE - 350, SNOW_LINE + 50, h) * (1 - smoothstep(G.snowLow, G.snowHigh, slope))
    * (known ? COVER.snowOnLand : 1);
  col = mix(col, snow, snowy);
  if (water) col = [...WATER_COLOR];
  const s = sunVector(yaw);
  const g = detail && !water ? lit(n, detail.d, detail.fade) : { normal: n, grain: 1 };
  const diff = g.normal[0] * s[0] + g.normal[1] * s[1] + g.normal[2] * s[2];
  const shade = shadeFactor(diff, occlusion) * g.grain;
  col = [col[0] * shade, col[1] * shade, col[2] * shade];
  if (water && view) col = waterShine(col, view, yaw);
  return haze(col, range, h, eyeAlt);
}

/** Rec. 709 luminance of linear RGB, as the E2E tests measure it. */
export const luminance = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
