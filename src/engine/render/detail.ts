/**
 * The grain of the ground at your feet.
 *
 * A DEM post is 13 m or more; the meadow you stand on is three of them and,
 * lit by one smooth normal, a plain green sheet. Nothing in the data says
 * what is there, so the shade pass lays a little noise over the near range:
 * a small tiling texture at three sizes (coarse patches, a fine grain, and
 * a finest one for the ground right at your feet), that bumps the normal
 * and mottles the brightness. It is fixed to the ground, not to the
 * screen or the standpoint, so it stays put when you turn or walk; and it
 * fades out with range, long before the distances at which a pixel is
 * larger than a tile.
 *
 * This file is the texture and the formula; glsl.ts and wgsl.ts apply the
 * same with the constants injected (gpu/consts.ts).
 */

export const DETAIL = {
  /** Texels along each side of the tile. */
  size: 64,
  /** Ground a tile covers, metres: the fine grain and the coarse patches. */
  fine: 23,
  coarse: 211,
  /**
   * The finest grain: the fine tile, this many times smaller (a whole
   * number, so it lies on the same frame), at `finest` of the others' weight.
   */
  finer: 5,
  finest: 0.6,
  /** How much the brightness follows the noise: ± this at full strength. */
  grain: 0.13,
  /** Slope the steepest bump adds to the surface, metres per metre. */
  tilt: 0.4,
  /** Full to `near` metres of range, gone by `far`. */
  near: 300,
  far: 2400,
};

const R = 6371008.8;
const DEG = Math.PI / 180;

/** mulberry32: small, fast and the same everywhere. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let cached: Uint8Array | null = null;

/**
 * The tile, size² RGBA: B the noise value, R and G its slope to the east
 * and north (each 127.5 neutral), A 255. White noise smoothed round the
 * edges of the tile, so it repeats without a seam; a share of a broader
 * smoothing gives the grain clumps.
 */
export function detailTexture(): Uint8Array {
  if (cached) return cached;
  const N = DETAIL.size, n = N * N;
  const rnd = prng(0x51ab);
  let v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = rnd() - 0.5;
  const wrap = (i: number) => ((i % N) + N) % N;
  const blur = (src: Float32Array, radius: number) => {
    const tmp = new Float32Array(n), out = new Float32Array(n);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) s += src[y * N + wrap(x + d)];
      tmp[y * N + x] = s;
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) s += tmp[wrap(y + d) * N + x];
      out[y * N + x] = s;
    }
    return out;
  };
  const unit = (a: Float32Array) => {
    let mean = 0, peak = 0;
    for (let i = 0; i < n; i++) mean += a[i];
    mean /= n;
    for (let i = 0; i < n; i++) { a[i] -= mean; peak = Math.max(peak, Math.abs(a[i])); }
    for (let i = 0; i < n; i++) a[i] /= peak;
    return a;
  };
  const fineGrain = unit(blur(v, 1)), clumps = unit(blur(blur(v, 3), 3));
  v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = fineGrain[i] * 0.6 + clumps[i] * 0.4;
  unit(v);
  const gx = new Float32Array(n), gy = new Float32Array(n);
  let steepest = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    gx[i] = v[y * N + wrap(x + 1)] - v[y * N + wrap(x - 1)];
    gy[i] = v[wrap(y + 1) * N + x] - v[wrap(y - 1) * N + x];
    steepest = Math.max(steepest, Math.abs(gx[i]), Math.abs(gy[i]));
  }
  const byte = (c: number) => Math.min(255, Math.max(0, Math.round(127.5 + 127.5 * c)));
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = byte(gx[i] / steepest);
    out[i * 4 + 1] = byte(gy[i] / steepest);
    out[i * 4 + 2] = byte(v[i]);
    out[i * 4 + 3] = 255;
  }
  cached = out;
  return out;
}

/**
 * Where the tiles lie for a standpoint: tiles per radian of the Mercator
 * offsets the shade pass has (fine, coarse), and the standpoint's own place
 * in a tile of each as a fraction (east, north; fine, coarse), worked out in
 * double precision. The scale is taken at the whole degree of latitude
 * nearest the standpoint, so that walking does not stretch the pattern
 * under you; a tile is its nominal size to a per cent.
 */
export interface DetailFrame {
  scale: [number, number];
  origin: [number, number, number, number];
  /** The standpoint's latitude, degrees: what metres on the ground are in those offsets. */
  lat: number;
}

export function detailFrame(lon: number, lat: number): DetailFrame {
  const perRadian = R * Math.cos(Math.round(lat) * DEG);
  const iso = Math.asinh(Math.tan(lat * DEG));
  const fract = (x: number) => x - Math.floor(x);
  const fine = perRadian / DETAIL.fine, coarse = perRadian / DETAIL.coarse;
  return {
    scale: [fine, coarse],
    origin: [fract(lon * DEG * fine), fract(iso * fine), fract(lon * DEG * coarse), fract(iso * coarse)],
    lat,
  };
}

/** The tile at a texture coordinate, blended between texels and repeating: slope east, slope north, value, each 0..1. */
function sample(u: number, v: number): [number, number, number] {
  const tex = detailTexture(), N = DETAIL.size;
  const x = u * N - 0.5, y = v * N - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const wrap = (i: number) => ((i % N) + N) % N;
  const at = (xx: number, yy: number, c: number) => tex[(wrap(yy) * N + wrap(xx)) * 4 + c] / 255;
  return [0, 1, 2].map((c) => (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty)
    + (at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx) * ty) as [number, number, number];
}

/**
 * The grain at a spot `east` and `north` metres from the standpoint of a
 * frame: slope east, slope north and value: the fine and the coarse tile
 * added, each −1..1, plus the finest at its weight. What the shade pass
 * reads, at the finest mip.
 */
export function detailAt(frame: DetailFrame, east: number, north: number): [number, number, number] {
  const perMetre = 1 / (R * Math.cos(frame.lat * DEG));
  const dLon = east * perMetre, dIso = north * perMetre;
  const u = dLon * frame.scale[0] + frame.origin[0], v = dIso * frame.scale[0] + frame.origin[1];
  const a = sample(u, v);
  const b = sample(dLon * frame.scale[1] + frame.origin[2], dIso * frame.scale[1] + frame.origin[3]);
  const c = sample(u * DETAIL.finer, v * DETAIL.finer);
  return [0, 1, 2].map((i) => a[i] + b[i] - 1 + DETAIL.finest * (2 * c[i] - 1)) as [number, number, number];
}

/** How much of the grain is left at a range, metres: all of it near, none from DETAIL.far. */
export function detailFade(range: number): number {
  const t = Math.min(1, Math.max(0, (range - DETAIL.near) / (DETAIL.far - DETAIL.near)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * The grain applied: the normal the light sees, leaning away from where the
 * noise rises, and the factor on the brightness. `d` as detailAt gives it,
 * `fade` as detailFade (times the renderer's switch).
 */
export function lit(n: [number, number, number], d: [number, number, number], fade: number): { normal: [number, number, number]; grain: number } {
  const x = n[0] - DETAIL.tilt * fade * d[0], y = n[1] - DETAIL.tilt * fade * d[1], z = n[2];
  const l = Math.hypot(x, y, z);
  return { normal: [x / l, y / l, z / l], grain: 1 + DETAIL.grain * fade * d[2] };
}
