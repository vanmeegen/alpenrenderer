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
  quality: Quality, hf: HeightField, arc: { start: number; span: number } | null = null, band: Band | null = null,
): RadialParams {
  const { azimuths, rows } = quality;
  const { az0, azStep } = wedge(azimuths, arc);
  const post = Math.max(12, hf.levels[0]?.res ?? 30);
  const maxRange = Math.max(hf.maxRange, post * 64);
  const r0 = 2;
  if (band) {
    // The telescope: the shader's linear middle segment becomes a dense band
    // of rings a post apart around the distance looked at, and the two
    // geometric segments share the remaining rows by the span they cover.
    // Zoomed in, the ground between the feet and the band is a thin strip
    // at the bottom of the frame; the band is what the view is about.
    const { r1, r2 } = band;
    const res = hf.levels[0]?.res ?? 30;
    const bandRows = Math.min(Math.floor(0.45 * rows), Math.max(2, Math.ceil((r2 - r1) / res)));
    const step = (r2 - r1) / bandRows;
    const maxR = Math.max(maxRange, r2 * 1.5);
    const spanA = Math.log(r1 / r0), spanB = Math.log(maxR / r2);
    const rest = rows - 1 - bandRows;
    const rowsA = Math.max(1, Math.min(rest - 1, Math.round((rest * spanA) / (spanA + spanB))));
    const jNear = rowsA, jSplit = rowsA + bandRows;
    return {
      az0, azStep, columns: azimuths, r0, logRatioNear: spanA / rowsA, jNear, rNearEnd: r1, post: step,
      jSplit, rSplit: r2, logRatioFar: spanB / (rows - 1 - jSplit), rows,
    };
  }
  const ratioNear = 1.15;
  const logRatioNear = Math.log(ratioNear);
  const jNear = Math.max(1, Math.ceil(Math.log(post / (ratioNear - 1) / r0) / logRatioNear));
  const rNearEnd = r0 * Math.exp(jNear * logRatioNear);
  // No post-spaced middle segment any more: jSplit = jNear keeps the shader's three-segment form.
  const jSplit = jNear, rSplit = rNearEnd;
  const logRatioFar = Math.log(Math.max(maxRange, rSplit * 1.5) / rSplit) / (rows - 1 - jSplit);
  return { az0, azStep, columns: azimuths, r0, logRatioNear, jNear, rNearEnd, post, jSplit, rSplit, logRatioFar, rows };
}

/** Ground ranges a dense band of rings covers (the telescope). */
export interface Band { r1: number; r2: number }

/**
 * The band for a distance looked at: the distance quantised in steps of
 * ×1.25 (so panning across a slope leaves the rings where they are) with
 * room on both sides, 0.8× to 1.5625× of the quantised value. Nothing within
 * a kilometre: the near rings are dense already. Null for the sky.
 */
export function bandFor(lookRange: number | null): Band | null {
  if (lookRange === null || !(lookRange >= 1000)) return null;
  const q = 1000 * 1.25 ** Math.floor(Math.log(lookRange / 1000) / Math.log(1.25));
  return { r1: 0.8 * q, r2: 1.5625 * q };
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
  if (f < p.jNear) return p.r0 * Math.exp(f * p.logRatioNear);
  if (f < p.jSplit) return p.rNearEnd + (f - p.jNear) * p.post;
  return p.rSplit * Math.exp((f - p.jSplit) * p.logRatioFar);
}

/** The (fractional) ring at a ground range: the inverse of `radiusAt`. */
export function rowAt(p: RadialParams, r: number): number {
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
 * window the window's finer posts, blended out at its edge (HeightField.lookAt).
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
  const look = hf.lookAt(lon, lat);
  if (look) {
    const hl = hf.heightIn(look.level, lon, lat);
    if (!Number.isNaN(hl)) h = hl + (h - hl) * look.fade;
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
