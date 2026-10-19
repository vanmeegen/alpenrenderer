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
  /** Where the pin stands: the summit, or the visible edge of its own mountain (horizon.ts ownCrest). */
  anchor: { lon: number; lat: number };
  /** The pin was moved onto the visible edge; `range` and the text stay the summit's. */
  atCrest?: boolean;
  /**
   * How big the feature looks from here, radians: the angle its own rise
   * takes up, atan(prominence / range) for a summit, atan(width / range) for
   * a lake. What the labels are handed out by; 0 when nothing is known.
   */
  rank: number;
  visible: boolean;
  /** Whether the sightline has been checked yet; until then `visible` is a placeholder false. */
  decided: boolean;
  /** 0 at the main point; 1.. at the peak's spare spots, in order of preference. */
  spot: number;
  /**
   * Moves the anchor onto the drawn top, asked the first time the label
   * lands on screen and again whenever the drawn surface changes (see
   * buildTargets' `drawn` and LayoutOptions.drawnKey).
   */
  settle: ((self: LabelTarget) => Pick<LabelTarget, 'east' | 'north' | 'up' | 'range' | 'bearing' | 'elevation' | 'anchorAlt'>) | null;
  /** The drawnKey the anchor was last settled for. */
  settledFor?: string;
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
  /**
   * Names the drawn surface (the mesh's wedge and rings). The mesh follows
   * the view, so a summit is drawn by another vertex after a zoom; a label
   * settled for one key settles again for the next.
   */
  drawnKey?: string;
}

const NEAR_ANCHOR_M = 140;

/**
 * Builds the per-observer geometry. Called when the observer moves, not per
 * frame — nothing here depends on where the camera is pointing.
 */
export function buildTargets(
  peaks: Peak[], obs: Observer, hf: HeightField, maxRange: number,
  /**
   * The summit as the renderer draws it, where and how high (render/mesh.ts
   * `meshTopNear`: the visible top of the mesh cell holding the summit). Far
   * out the mesh rings are a percent or two of the range apart and a sharp
   * summit is drawn lower, and up to a cell off, from where the DEM holds
   * it; zoomed in, a pin on the DEM summit stands in the air or in the
   * slope. The pin goes exactly onto the drawn vertex, so its tip lies on
   * the drawn surface. Asked lazily, by layoutLabels, for labels that land
   * on screen.
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
      const size = p.kind === 'lake' ? p.extent : p.prom;
      out.push({
        peak: p,
        east: o.east, north: o.north, up: o.up,
        range: o.range, bearing: o.bearing, elevation: o.elevation,
        anchorAlt,
        anchor: { lon: a.lon, lat: a.lat },
        rank: size ? Math.atan2(size, o.range) : 0,
        visible: false,
        decided: false,
        spot,
        // Sixteen mesh samples a summit: cheap for the few on screen, a
        // frozen phone for forty thousand at every rebuild. So later.
        settle: drawn && p.kind !== 'lake'
          ? (self) => {
            const d = drawn(self.anchor.lon, self.anchor.lat);
            const s = localOffset({ lon: obs.lon, lat: obs.lat, alt: eye }, { lon: d.lon, lat: d.lat, alt: d.h });
            return {
              east: s.east, north: s.north, up: s.up,
              // A pin on the mountain's edge keeps saying how far the summit is.
              range: self.atCrest ? self.range : s.range,
              bearing: s.bearing, elevation: s.elevation, anchorAlt: d.h,
            };
          }
          : null,
      });
    });
  }
  // By apparent prominence, biggest first (PeakVisor ranks by prominence;
  // OpenTopoMap thins summits by isolation). The angle a summit's own rise
  // takes up from here says what the eye sees: the 400 m hill 7 km away
  // (0.057 rad) before the 1000 m summit 40 km behind it (0.025), but the
  // 4000er with 1700 m of prominence 50 km out (0.034) before the 30 m knoll
  // at the foot of the hill (0.030). Ranking by fame alone filled the slots
  // with 3000ers 50 km out; ranking by distance alone named every bump in
  // front and left the pointed peak behind it nameless. The sightline job
  // works in this order too, so the labels that matter appear first.
  out.sort((a, b) => b.rank - a.rank || a.range - b.range);
  return out;
}

/**
 * Screen placement. The screen is a grid of cells about one label wide and
 * two lines tall; each cell names one feature, the best-ranked one whose
 * anchor falls into it (the tessellation of Raposo, Brewer and Stanislawski
 * 2013: a retained summit has room for its label). Zooming in spreads the
 * anchors over more cells, so more summits get their names, as a telescope
 * does in PeakFinder. Labels are stacked upwards from their summit; one that
 * finds no free slot is dropped rather than allowed to overlap, and leaves
 * its cell to the next.
 */
/**
 * Moves a label's pin onto another point of its mountain: the visible edge
 * the sightline march found in front of a summit hidden a little behind
 * it (horizon.ts ownCrest). Geometry and height are the edge's; `range`,
 * `bearing`, `rank` and the text stay the summit's, and the pin settles
 * onto the drawn surface at the edge like any other.
 */
export function pinAt(
  t: LabelTarget, point: { lon: number; lat: number; h: number }, obs: { lon: number; lat: number; alt: number },
) {
  const s = localOffset(obs, { lon: point.lon, lat: point.lat, alt: point.h });
  t.east = s.east;
  t.north = s.north;
  t.up = s.up;
  t.elevation = s.elevation;
  t.anchorAlt = point.h;
  t.anchor = { lon: point.lon, lat: point.lat };
  t.atCrest = true;
  t.settledFor = undefined;
}

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

  const cellW = 9 * opt.lineHeight, cellH = 3 * opt.lineHeight;
  const taken = new Set<number>();
  const cellOf = (x: number, y: number) => Math.floor(x / cellW) + 4096 * Math.floor(y / cellH);

  for (let i = 0; i < targets.length && placed.length < opt.maxLabels; i++) {
    const t = targets[i];
    if (!t.visible || chosen.get(t.peak.id) !== t) continue;
    let w = cam.project(t.east, t.north, t.up, ndc);
    if (w <= 0) continue;
    let ax = (ndc[0] * 0.5 + 0.5) * opt.width;
    let ay = (1 - (ndc[1] * 0.5 + 0.5)) * opt.height;
    if (ax < -40 || ax > opt.width + 40 || ay < -40 || ay > opt.height + 40) continue;
    if (taken.has(cellOf(ax, ay))) continue;
    if (t.settle && t.settledFor !== (opt.drawnKey ?? '')) {
      // On screen for the first time, or drawn anew: onto the summit as the mesh draws it.
      Object.assign(t, t.settle(t));
      t.settledFor = opt.drawnKey ?? '';
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
    taken.add(cellOf(ax, ay));
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
