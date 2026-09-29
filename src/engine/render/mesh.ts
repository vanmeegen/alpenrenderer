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
import { HeightField, Level } from '../core/heightfield';
import type { Quality } from './gpu/renderer';

export interface RadialParams {
  azStep: number;
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

/** The ring layout for a quality and a height field; the renderer's uniforms come from here. */
export function radialParams(quality: Quality, hf: HeightField): RadialParams {
  const { azimuths, rows } = quality;
  const azStep = (2 * Math.PI) / azimuths;
  // Step through the middle segment at the finest level's post spacing, but
  // never finer than 12 m: with 6.6 m LiDAR-grade data the rows would all be
  // spent inside the first two kilometres and the far field would coarsen.
  // The finest level still feeds the *height* of every vertex it covers.
  const post = Math.max(12, hf.levels[0]?.res ?? 30);
  const maxRange = Math.max(hf.maxRange, post * 64);
  const r0 = 2;
  const ratioNear = 1.15;
  const logRatioNear = Math.log(ratioNear);
  const jNear = Math.max(1, Math.ceil(Math.log(post / (ratioNear - 1) / r0) / logRatioNear));
  const rNearEnd = r0 * Math.exp(jNear * logRatioNear);
  const splitTarget = Math.min(post / azStep, maxRange * 0.6);
  const jSplit = Math.min(rows - 8, jNear
    + Math.max(2, Math.round((splitTarget - rNearEnd) / post)));
  const rSplit = rNearEnd + (jSplit - jNear) * post;
  const logRatioFar = Math.log(Math.max(maxRange, rSplit * 1.5) / rSplit) / (rows - 1 - jSplit);
  return { azStep, r0, logRatioNear, jNear, rNearEnd, post, jSplit, rSplit, logRatioFar, rows };
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

/** The height a vertex at ground range `r` gets: the shader's level choice and cross-fade. */
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
  const a0 = Math.floor(az / p.azStep), f0 = Math.floor(rowAt(p, range));
  let top: { lon: number; lat: number; h: number } | null = null, topRise = -Infinity;
  for (let f = Math.max(0, f0); f <= Math.min(p.rows - 1, f0 + 1); f++) {
    const r = radiusAt(p, f);
    for (let a = a0; a <= a0 + 1; a++) {
      const v = destination(hf.lon, hf.lat, (a * p.azStep * 180) / Math.PI, r, radius);
      const h = vertexHeight(hf, v.lon, v.lat, r);
      const rise = (h - eyeAlt - curvatureDrop(r, radius)) / r;
      if (rise > topRise) { top = { lon: v.lon, lat: v.lat, h }; topRise = rise; }
    }
  }
  return top ?? { lon, lat, h: hf.height(lon, lat, range) };
}
