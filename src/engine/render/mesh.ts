/**
 * The polar terrain mesh on the CPU: ring spacing and height sampling exactly
 * as the vertex shader has them (glsl.ts/wgsl.ts `radiusAt`, `levelFor`,
 * `sampleLevel`), so that code outside the GPU can ask what the mesh draws.
 *
 * Beyond a few kilometres the rings are a percent or two of the range apart:
 * at 15 km that is 170 m (desktop) to 250 m (phone), and a sharp summit
 * falls between two rings and is drawn lower than the DEM holds it. At a 60°
 * field of view nobody sees that; zoomed in, a label anchored on the DEM's
 * summit floats above the drawn one. `meshTopNear` gives the drawn height.
 */

import { bearing, curvatureDrop, destination, groundRange, localRadius } from '../core/geodesy';

const DEG = Math.PI / 180;
import { HeightField, Level } from '../core/heightfield';
import { FrameView, SCAN, scanBin, scanBins, scanStart } from './framescan';
import type { Quality } from './gpu/renderer';

export interface RadialParams {
  /** Bearing of column 0, radians, snapped to the column grid; 0 for the whole circle. */
  az0: number;
  azStep: number;
  /** Columns in the wedge (the quality's azimuths). */
  columns: number;
  r0: number;
  logRatioNear: number;
  jNear: number;
  rNearEnd: number;
  post: number;
  jSplit: number;
  rSplit: number;
  logRatioFar: number;
  rows: number;
  /**
   * The radius of every ring, when the rings follow what the frame shows
   * (ringTable) instead of the three segments above.
   */
  radii?: Float64Array;
}

/**
 * The columns of the mesh over the view instead of the whole circle: the
 * frustum's bearing arc (camera.azimuthArc) shared out over the columns, with
 * a spare column at each end, so that a column is about a pixel wide at
 * every field of view (0.09° at 60°, 0.005° at 5°) instead of 0.18° always —
 * the screen-space-error idea of Cesium and MapLibre on a polar mesh. The
 * first column sits on a multiple of the step, so panning within a column
 * moves nothing: the vertices stay on their ground until the step changes.
 * A view steep enough to sweep every bearing (arc null) takes the circle.
 */
export function wedge(azimuths: number, arc: { start: number; span: number } | null): { az0: number; azStep: number } {
  if (!arc || arc.span >= 360) return { az0: 0, azStep: (2 * Math.PI) / azimuths };
  const azStep = (arc.span * DEG) / (azimuths - 2);
  return { az0: Math.floor((arc.start * DEG) / azStep) * azStep, azStep };
}

/**
 * The ring layout for a quality and a height field, and the columns for a
 * view; the renderer's uniforms come from here. Rings: geometric near the
 * feet (2 m, ×1.15), so the ground there is not one enormous triangle, then
 * geometric at a constant fraction of the range out to the last level —
 * 1/190 of the range (high), 1/120 (low), of the order of the clipmap's own
 * posts (1/318 to 1/159), so a ridge is drawn where the DEM has it and a
 * summit lands on a ring (§8.y had them 0–60 m too low at 1.1–1.4 %).
 */
export function radialParams(
  quality: Quality, hf: HeightField, arc: { start: number; span: number } | null = null, radii: Float64Array | null = null,
): RadialParams {
  const { azimuths, rows } = quality;
  const { az0, azStep } = wedge(azimuths, arc);
  const post = Math.max(12, hf.levels[0]?.res ?? 30);
  const maxRange = Math.max(hf.maxRange, post * 64);
  const r0 = RINGS.r0;
  const ratioNear = 1.15;
  const logRatioNear = Math.log(ratioNear);
  const jNear = Math.max(1, Math.ceil(Math.log(post / (ratioNear - 1) / r0) / logRatioNear));
  const rNearEnd = r0 * Math.exp(jNear * logRatioNear);
  // No post-spaced middle segment any more: jSplit = jNear keeps the shader's three-segment form.
  const jSplit = jNear, rSplit = rNearEnd;
  const logRatioFar = Math.log(Math.max(maxRange, rSplit * 1.5) / rSplit) / (rows - 1 - jSplit);
  const p: RadialParams = { az0, azStep, columns: azimuths, r0, logRatioNear, jNear, rNearEnd, post, jSplit, rSplit, logRatioFar, rows };
  // Zoomed in, the rings lie where the frame shows ground: a table, one radius a ring.
  if (radii && radii.length === rows) p.radii = radii;
  return p;
}

/** Ground ranges a dense band of rings covers (the telescope). */
export const RINGS = {
  /** The innermost ring, metres (framescan.ts SCAN.r0: the bins start there too). */
  r0: SCAN.r0,
  /** Pixels of the picture between two rings, on ground that rises into view. */
  seen: 2,
  /** With rings to spare they come this much closer, no more. */
  finest: 0.5,
  /**
   * Share of the range between two rings at most where ground is in the
   * frame, seen or not: a ring a bin. Closer, and the ground at the feet
   * (a hundred bins of it) takes half the rows of a phone for nothing.
   */
  inFrame: 0.025,
  /** Share of the range between two rings elsewhere. */
  rest: 0.05,
} as const;

/** The largest value three bytes hold: a ring's radius goes to the GPU as that share of the logarithm's span. */
export const RING_CODE = 16777215;

/**
 * The rings for a zoomed frame: one radius a row, from RINGS.r0 to
 * `maxRange`, where `view` (framescan.ts) says what the frame shows of
 * each bin of distance and `pxAngle` is the angle of a pixel, radians.
 *
 * A bin gets as many rings as it brings pixels of the picture into view,
 * one every RINGS.seen pixels: the surface between two rings is flat, so
 * a crest that falls between them is drawn lower by what the nearer of
 * them lies under it on screen, and that is less than their distance on
 * screen. Wherever the frame shows a crest, then, it is at most that much
 * too low, not only where the frame's centre points (the one dense band
 * this replaces had rings 7 m apart at the centre and 200–300 m beside
 * it). A plain in view takes the rows of the screen it fills, whatever
 * its depth. Ground in the frame gets a ring every RINGS.inFrame of the
 * range at least (a strip the scan's rays missed), the rest every
 * RINGS.rest. If the rows do not reach, the pixels between rings are
 * stretched for all bins alike, in steps of 2^⅛, until they do: the error
 * is shared by all that is seen. Rows to spare lie on the last ring.
 *
 * The rings of a bin are a lattice in the logarithm of the range,
 * r0·exp(k·δ), with δ on a ladder of 2^¼: a stretch of ground keeps its
 * rings whatever the frame shows elsewhere, and panning moves none.
 */
export function ringTable(rows: number, view: FrameView, pxAngle: number, maxRange: number): Float64Array {
  const { classes, need } = view;
  const rest = Math.log(1 + RINGS.rest), inFrame = Math.log(1 + RINGS.inFrame), bin = Math.log(SCAN.ratio);
  // δ for a wanted spacing (a share of the range): the next finer on the ladder, never coarser than `most`.
  const onLadder = (want: number, most: number) => (want >= most ? most : rest * 2 ** (-Math.ceil(4 * Math.log2(rest / want) - 1e-9) / 4));
  // Bins the scan did not reach (terrain that arrived since) count as not in the frame.
  const bins = Math.max(classes.length, scanBins(maxRange));
  const out = new Float64Array(rows);
  const lay = (stretch: number, write: boolean): number => {
    let n = 0;
    if (write) out[n] = RINGS.r0;
    n++;
    const end = Math.log(maxRange / RINGS.r0);
    for (let b = 0; b < bins; b++) {
      const most = classes[b] >= 1 ? inFrame : rest;
      // Rings in the bin: the pixels it brings into view, one ring every `seen · stretch` of them.
      const rings = (need[b] ?? 0) / (RINGS.seen * stretch * pxAngle);
      const d = rings > 0 ? onLadder(bin / rings, most) : most;
      const lo = Math.log(scanStart(b) / RINGS.r0), hi = Math.min(end, Math.log(scanStart(b + 1) / RINGS.r0));
      // Lattice points in [lo, hi), past the first ring and short of the last.
      for (let k = Math.max(1, Math.ceil(lo / d - 1e-9)); k * d < hi - 1e-9; k++) {
        if (write && n < rows - 1) out[n] = RINGS.r0 * Math.exp(k * d);
        n++;
      }
    }
    return n + 1;                                             // and the ring on the last level's edge
  };
  let stretch = RINGS.finest, n = lay(stretch, false);
  for (let i = 0; n > rows && i < 96; i++) {
    stretch *= 2 ** 0.125;
    n = lay(stretch, false);
  }
  lay(stretch, true);
  if (n > rows) {
    // Fewer rows than even the coarsest lattice asks for: every so-manyth ring of it.
    const all: number[] = [RINGS.r0];
    const end = Math.log(maxRange / RINGS.r0);
    for (let k = 1; k * rest < end - 1e-9; k++) all.push(RINGS.r0 * Math.exp(k * rest));
    for (let i = 0; i < rows - 1; i++) out[i] = all[Math.min(all.length - 1, Math.round((i * (all.length - 1)) / Math.max(1, rows - 2)))];
    out[rows - 1] = maxRange;
    return out;
  }
  for (let i = n - 1; i < rows; i++) out[i] = maxRange;
  return out;
}

/**
 * Where along the view the telescope's data windows go: for each window,
 * the finest first, the ground range of its middle, or null when the frame
 * shows nothing left for it. A window serves a stretch `depth` long (the
 * part of it drawn at full weight). The finest takes the nearest ground
 * seen (`classes`, framescan.ts) beyond `from`, where the eye's own level
 * of that zoom ends and the window has something to add; the next goes on
 * where it ends, skipping what is hidden or out of the frame. So the posts
 * a mountain is drawn from depend on what the frame shows, the nearest the
 * finest (a pixel is least ground there), and not on where its centre
 * points: around the centre's spot, the mountain beside it came from posts
 * eight times as far apart and changed when the centre moved on.
 */
export function lookRanges(classes: Uint8Array, windows: { depth: number; from: number }[]): (number | null)[] {
  let pos = 0;
  return windows.map((w) => {
    const lo = Math.max(pos, w.from, RINGS.r0);
    for (let b = scanBin(lo); b < classes.length; b++) {
      if (classes[b] !== 2) continue;
      const start = Math.max(lo, scanStart(b));
      pos = start + w.depth;
      return start + w.depth / 2;
    }
    return null;
  });
}

/** The radius of every ring of a layout: its table, or the three segments worked out. */
export function ringsOf(p: RadialParams): Float64Array {
  if (p.radii) return p.radii;
  const out = new Float64Array(p.rows);
  for (let f = 0; f < p.rows; f++) out[f] = radiusAt(p, f);
  return out;
}

/**
 * The table as the vertex shader reads it: a texel a ring, in R, G, B the
 * logarithm of its radius as a share (of RING_CODE) of the span from the
 * first ring to the last. Three bytes resolve 7e-7 of the range.
 */
export function encodeRings(radii: Float64Array): { bytes: Uint8Array; r0: number; span: number } {
  const r0 = radii[0], span = Math.max(1e-9, Math.log(radii[radii.length - 1] / r0));
  const bytes = new Uint8Array(radii.length * 4);
  for (let i = 0; i < radii.length; i++) {
    const v = Math.min(RING_CODE, Math.max(0, Math.round((Math.log(radii[i] / r0) / span) * RING_CODE)));
    bytes[i * 4] = v >>> 16;
    bytes[i * 4 + 1] = (v >>> 8) & 255;
    bytes[i * 4 + 2] = v & 255;
    bytes[i * 4 + 3] = 255;
  }
  return { bytes, r0, span };
}

/**
 * Where the ray through the centre of the view meets the ground: the ground
 * range in metres, or null when it points at the sky. A march along the
 * bearing in steps of 0.2 % of the range (a 13 m post 10 km out is still
 * hit), with curvature and refraction as the renderer draws them.
 */
export function lookRange(hf: HeightField, eyeAlt: number, yaw: number, pitch: number): number | null {
  const radius = localRadius(hf.lat);
  const tanP = Math.tan(pitch * DEG);
  const maxR = hf.maxRange;
  if (maxR <= 0) return null;
  let prev = 2, prevAbove = true;
  for (let r = 2; r <= maxR; r *= 1.002) {
    const p = destination(hf.lon, hf.lat, yaw, r, radius);
    const ray = eyeAlt + r * tanP - curvatureDrop(r, radius);
    const above = hf.height(p.lon, p.lat, r) < ray;
    if (!above) {
      // Bisect between the last sample above ground and this one below.
      let lo = prev, hi = r;
      for (let i = 0; i < 12; i++) {
        const m = (lo + hi) / 2;
        const q = destination(hf.lon, hf.lat, yaw, m, radius);
        if (hf.height(q.lon, q.lat, m) < eyeAlt + m * tanP - curvatureDrop(m, radius)) lo = m; else hi = m;
      }
      return prevAbove ? (lo + hi) / 2 : r;
    }
    prev = r;
    prevAbove = above;
  }
  return null;
}

/** Ground range of ring `f` (the shader's `radiusAt`). */
export function radiusAt(p: RadialParams, f: number): number {
  if (p.radii) {
    const t = p.radii, i = Math.min(t.length - 2, Math.max(0, Math.floor(f)));
    // Between two rings, geometrically: where the row index is a fraction, as the lattice is.
    return t[i] * (t[i + 1] / t[i]) ** (f - i);
  }
  if (f < p.jNear) return p.r0 * Math.exp(f * p.logRatioNear);
  if (f < p.jSplit) return p.rNearEnd + (f - p.jNear) * p.post;
  return p.rSplit * Math.exp((f - p.jSplit) * p.logRatioFar);
}

/** The (fractional) ring at a ground range: the inverse of `radiusAt`. */
export function rowAt(p: RadialParams, r: number): number {
  if (p.radii) {
    const t = p.radii;
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (t[m] <= r) lo = m; else hi = m;
    }
    return t[lo + 1] > t[lo] ? lo + Math.log(Math.max(r, 1e-9) / t[lo]) / Math.log(t[lo + 1] / t[lo]) : lo;
  }
  if (r < p.rNearEnd) return Math.log(Math.max(r, 1e-9) / p.r0) / p.logRatioNear;
  if (r < p.rSplit) return p.jNear + (r - p.rNearEnd) / p.post;
  return p.jSplit + Math.log(r / p.rSplit) / p.logRatioFar;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The height a vertex at ground range `r` gets: the shader's level choice
 * and cross-fade over the observer's levels, and inside the telescope's
 * windows their finer posts, the coarsest first, each over the result by
 * its share (HeightField.looksAt).
 */
export function vertexHeight(hf: HeightField, lon: number, lat: number, r: number): number {
  const levels = hf.levels;
  let i = levels.length - 1;
  for (let k = 0; k < levels.length; k++) {
    const l = levels[k];
    if (l.filled && r <= l.maxRange) { i = k; break; }
  }
  const at = (l: Level) => {
    const h = hf.heightIn(l, lon, lat);
    return Number.isNaN(h) ? hf.height(lon, lat, r) : h;
  };
  let h = at(levels[i]);
  if (i + 1 < levels.length) {
    const outer = levels[i].maxRange;
    const fade = smoothstep(outer * 0.86, outer, r);
    if (fade > 0) h += (at(levels[i + 1]) - h) * fade;
  }
  for (const { level, share } of hf.looksAt(lon, lat)) {
    const hl = hf.heightIn(level, lon, lat);
    if (!Number.isNaN(hl)) h += (hl - h) * share;
  }
  return h;
}

/**
 * The summit as drawn. The drawn surface is made of flat triangles between
 * the mesh vertices, so its high points are vertices; a summit at a point is
 * drawn by the one cell of the mesh that contains the point, and of that
 * cell's four corners the one that stands highest seen from the eye is the
 * top of it on screen: the corner with the largest elevation angle (a
 * corner further back can be higher above the sea and still be hidden
 * behind a nearer one). Returns that vertex, position and height: a label
 * pin put there lies exactly on the drawn surface, at its visible top, at
 * most one cell from the point. Curvature and refraction as for the labels.
 */
export function meshTopNear(
  hf: HeightField, p: RadialParams, lon: number, lat: number, eyeAlt: number,
): { lon: number; lat: number; h: number } {
  const radius = localRadius(hf.lat);
  const range = groundRange(hf.lon, hf.lat, lon, lat, radius);
  const az = (bearing(hf.lon, hf.lat, lon, lat) * Math.PI) / 180;
  // Column index within the wedge; a point the wedge does not reach is not drawn at all.
  const rel = az - p.az0 - 2 * Math.PI * Math.floor((az - p.az0) / (2 * Math.PI));
  const a0 = Math.floor(rel / p.azStep), f0 = Math.floor(rowAt(p, range));
  if (a0 + 1 > p.columns) return { lon, lat, h: hf.height(lon, lat, range) };
  let top: { lon: number; lat: number; h: number } | null = null, topRise = -Infinity;
  for (let f = Math.max(0, f0); f <= Math.min(p.rows - 1, f0 + 1); f++) {
    const r = radiusAt(p, f);
    for (let a = a0; a <= a0 + 1; a++) {
      const v = destination(hf.lon, hf.lat, ((p.az0 + a * p.azStep) * 180) / Math.PI, r, radius);
      const h = vertexHeight(hf, v.lon, v.lat, r);
      const rise = (h - eyeAlt - curvatureDrop(r, radius)) / r;
      if (rise > topRise) { top = { lon: v.lon, lat: v.lat, h }; topRise = rise; }
    }
  }
  return top ?? { lon, lat, h: hf.height(lon, lat, range) };
}
