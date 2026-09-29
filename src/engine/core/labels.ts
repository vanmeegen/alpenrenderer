/**
 * Turning a summit catalogue into a readable set of labels.
 *
 * Three separate jobs, deliberately kept apart:
 *   geometry   where a summit sits relative to the observer (curvature and
 *              refraction included, same frame the renderer uses);
 *   visibility whether the terrain hides it — answered by the GPU against the
 *              rendered range buffer, not by a horizon algorithm;
 *   layout     which of the survivors can be shown without overlapping.
 */

import { Camera } from './camera';
import { localOffset } from './geodesy';
import { HeightField, Observer } from './heightfield';
import { Peak } from './peaks';

export interface LabelTarget {
  peak: Peak;
  /** Local ENU of the label anchor, metres. */
  east: number;
  north: number;
  up: number;
  range: number;
  bearing: number;
  /** Apparent elevation angle, degrees, after curvature + refraction. */
  elevation: number;
  /** Altitude the anchor sits at — the DEM's summit, not the catalogue's. */
  anchorAlt: number;
  visible: boolean;
  /** Whether the sightline has been checked yet; until then `visible` is a placeholder false. */
  decided: boolean;
  /** 0 at the main point; 1.. at the peak's spare spots, in order of preference. */
  spot: number;
  /**
   * Moves the anchor onto the drawn top, asked the first time the label
   * lands on screen and then dropped (see buildTargets' `drawn`); null once
   * settled.
   */
  settle: (() => Pick<LabelTarget, 'east' | 'north' | 'up' | 'range' | 'bearing' | 'elevation' | 'anchorAlt'>) | null;
}

export interface PlacedLabel {
  target: LabelTarget;
  /** Anchor in CSS pixels. */
  ax: number;
  ay: number;
  /** Text box in CSS pixels. */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  lines: string[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  measure(text: string, big: boolean): number;
  /** Rough line height in CSS pixels. */
  lineHeight: number;
  maxLabels: number;
  /** How many of the top labels get a second line with distance/height. */
  detailed: number;
  /** Minimum gap between boxes, px. */
  gap: number;
}

const NEAR_ANCHOR_M = 140;

/**
 * Builds the per-observer geometry. Called when the observer moves, not per
 * frame — nothing here depends on where the camera is pointing.
 */
export function buildTargets(
  peaks: Peak[], obs: Observer, hf: HeightField, maxRange: number,
  /**
   * The top the renderer actually draws around a point, where and how high
   * (render/mesh.ts `meshTopNear`). Far out the mesh rings are a percent or
   * two of the range apart and a sharp summit is drawn lower, and a little
   * off, from where the DEM holds it; zoomed in, a pin on the DEM summit
   * stands in the air or in the slope. The pin goes onto the drawn top,
   * never above the DEM summit. Asked lazily, by layoutLabels, for labels
   * that land on screen.
   */
  drawn?: (lon: number, lat: number) => { lon: number; lat: number; h: number },
): LabelTarget[] {
  const eye = obs.ground + obs.eye;
  const out: LabelTarget[] = [];
  for (const p of peaks) {
    const anchors = p.spots ? [{ lon: p.lon, lat: p.lat }, ...p.spots] : [{ lon: p.lon, lat: p.lat }];
    anchors.forEach((c, spot) => {
      // Anchor on the summit the renderer actually draws. A catalogue elevation
      // can sit 130 m above the DEM's idea of the same summit; anchoring there
      // leaves the label floating in the sky above its own mountain. And a
      // catalogue point on the flank is moved onto the top, position and
      // height from the same DEM post: the top's height at the flank point
      // stood the pin in the air beside the summit, and lowered onto the
      // drawn surface there, in the slope. A lake's label point is on its
      // water; the summit search would climb the shore.
      let a = c;
      let anchorAlt: number;
      if (spot === 0 && p.demEle !== undefined) anchorAlt = p.demEle;
      else if (p.kind === 'lake') anchorAlt = hf.groundAt(c.lon, c.lat);
      else {
        const top = hf.summitAt(c.lon, c.lat, NEAR_ANCHOR_M);
        a = { lon: top.lon, lat: top.lat };
        anchorAlt = top.h;
      }
      const o = localOffset({ lon: obs.lon, lat: obs.lat, alt: eye },
        { lon: a.lon, lat: a.lat, alt: anchorAlt });
      if (o.range > maxRange || o.range < 20) return;
      out.push({
        peak: p,
        east: o.east, north: o.north, up: o.up,
        range: o.range, bearing: o.bearing, elevation: o.elevation,
        anchorAlt,
        visible: false,
        decided: false,
        spot,
        // Sixteen mesh samples a summit: cheap for the few on screen, a
        // frozen phone for forty thousand at every rebuild. So later.
        settle: drawn && p.kind !== 'lake'
          ? () => {
            const d = drawn(a.lon, a.lat);
            const alt = Math.min(d.h, anchorAlt);
            const s = localOffset({ lon: obs.lon, lat: obs.lat, alt: eye }, { lon: d.lon, lat: d.lat, alt });
            return {
              east: s.east, north: s.north, up: s.up, range: s.range,
              bearing: s.bearing, elevation: s.elevation, anchorAlt: alt,
            };
          }
          : null,
      });
    });
  }
  // Near before far. The hill in front is what a person on the spot asks
  // about; famous summits behind it get their names once zooming leaves room
  // (fewer near summits in the frame, labels further apart). Ranking by fame
  // instead filled the slots with 3000ers 50 km out and left the mountain
  // next to the standpoint unnamed. The sightline job works in this order
  // too, so the near labels are also the first to appear.
  out.sort((a, b) => a.range - b.range);
  return out;
}

/**
 * Screen placement. Labels are claimed in target order (nearest first) and stacked
 * upwards from their summit; a label that cannot find a free slot is dropped
 * rather than allowed to overlap, so the ones that survive stay readable.
 */
export function layoutLabels(
  targets: LabelTarget[], cam: Camera, opt: LayoutOptions,
): PlacedLabel[] {
  const ndc = new Float32Array(3);
  const placed: PlacedLabel[] = [];
  const boxes: PlacedLabel[] = [];
  const margin = 4;

  // One label per summit or lake: among its visible anchors, the most
  // preferred (its main point if that shows, else the first spare spot).
  const chosen = new Map<string, LabelTarget>();
  for (const t of targets) {
    if (!t.visible) continue;
    const c = chosen.get(t.peak.id);
    if (!c || t.spot < c.spot) chosen.set(t.peak.id, t);
  }

  for (let i = 0; i < targets.length && placed.length < opt.maxLabels; i++) {
    const t = targets[i];
    if (!t.visible || chosen.get(t.peak.id) !== t) continue;
    let w = cam.project(t.east, t.north, t.up, ndc);
    if (w <= 0) continue;
    let ax = (ndc[0] * 0.5 + 0.5) * opt.width;
    let ay = (1 - (ndc[1] * 0.5 + 0.5)) * opt.height;
    if (ax < -40 || ax > opt.width + 40 || ay < -40 || ay > opt.height + 40) continue;
    if (t.settle) {
      // On screen for the first time: onto the summit as the mesh draws it.
      Object.assign(t, t.settle());
      t.settle = null;
      w = cam.project(t.east, t.north, t.up, ndc);
      if (w <= 0) continue;
      ax = (ndc[0] * 0.5 + 0.5) * opt.width;
      ay = (1 - (ndc[1] * 0.5 + 0.5)) * opt.height;
    }

    const detailed = placed.length < opt.detailed;
    const lines = detailed
      ? [t.peak.name, `${fmtEle(t.peak) || (t.peak.kind === 'lake' ? `${Math.round(t.anchorAlt)} m` : '')} · ${fmtRange(t.range)}`]
      : [t.peak.name];
    const bw = Math.max(...lines.map((s, li) => opt.measure(s, li === 0))) + 12;
    const bh = lines.length * opt.lineHeight + 6;

    let bx = Math.min(Math.max(ax - bw / 2, 2), opt.width - bw - 2);
    let by = ay - 14 - bh;
    // Stack upwards from the summit; a summit too close to the top edge for
    // that keeps its label at the top and stacks downwards instead, because
    // the highest peak in view is the last one that should lose its name.
    let dir = -1;
    if (by < 2) { by = 2; dir = 1; }
    let ok = false;
    for (let attempt = 0; attempt < 26; attempt++) {
      if (by < 2 || by + bh > opt.height - 2) break;
      const hit = boxes.some((b) =>
        bx < b.bx + b.bw + opt.gap && bx + bw + opt.gap > b.bx
        && by < b.by + b.bh + margin && by + bh + margin > b.by);
      if (!hit) { ok = true; break; }
      by += dir * (opt.lineHeight + opt.gap);
    }
    if (!ok) continue;

    const p: PlacedLabel = { target: t, ax, ay, bx, by, bw, bh, lines };
    placed.push(p);
    boxes.push(p);
  }
  return placed;
}

export function fmtRange(m: number): string {
  return m < 9500 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
}

export function fmtEle(p: Peak): string {
  const e = p.ele ?? p.demEle;
  return e === undefined ? '' : `${Math.round(e)} m`;
}

/** Nearest placed label to a tap, or null. */
export function pickLabel(placed: PlacedLabel[], x: number, y: number, slop = 26): PlacedLabel | null {
  let best: PlacedLabel | null = null;
  let bestD = slop * slop;
  for (const p of placed) {
    if (x >= p.bx - 6 && x <= p.bx + p.bw + 6 && y >= p.by - 4 && y <= p.by + p.bh + 4) return p;
    const d = (x - p.ax) ** 2 + (y - p.ay) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
