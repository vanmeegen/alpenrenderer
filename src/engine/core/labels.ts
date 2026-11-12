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
  /** Nothing higher stands behind it: the summit is on the skyline (set with `visible`, horizon.ts). */
  skyline?: boolean;
  /**
   * How big the feature looks from here, radians: the angle its own rise
   * takes up, atan(prominence / range) for a summit (times what is known of
   * its fame, RANK), atan(width / range) for a lake. What the labels are
   * handed out by, with the skyline bonus on top (see `effectiveRank`).
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
  /**
   * What stands on the screen over the picture, CSS pixels: the menu rail,
   * the status panel, the compass. No label box overlaps one, and a summit
   * under one is not named (its pin would point under the panel).
   */
  blocked?: { x: number; y: number; w: number; h: number }[];
  /** What the last layout placed: those cells are filled first, in that order, so the stack of boxes does not reshuffle. */
  previous?: PlacedLabel[];
}

/**
 * What goes into a summit's rank besides the angle its prominence takes up.
 * `defaultProm`: a summit whose prominence nobody recorded (four fifths of
 * the catalogue) counts as a 25 m knoll, not as nothing. `wikipedia`,
 * `wikidata`: a summit people have written about is one people look for.
 * `skyline`: with the sky behind it a summit is what the eye picks out.
 * `lakeShare`: the most of the labels that go to lakes.
 */
export const RANK = { defaultProm: 25, wikipedia: 1.5, wikidata: 1.2, skyline: 1.6, lakeShare: 1 / 7 };

/** A cell of the label grid in line heights, and the ladder its angular size steps on. */
export const LABEL_GRID = { width: 9, height: 3, step: Math.SQRT2 };

/** The rank the layout hands the cells out by. */
export function effectiveRank(t: LabelTarget): number {
  return t.skyline ? t.rank * RANK.skyline : t.rank;
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
      // Out of range by more than the summit search could move it: dropped
      // before the search, which reads a few hundred posts of the DEM.
      const rough = localOffset({ lon: obs.lon, lat: obs.lat, alt: eye }, { lon: c.lon, lat: c.lat, alt: eye });
      if (rough.range > maxRange + NEAR_ANCHOR_M) return;
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
      const size = p.kind === 'lake' ? p.extent : p.prom ?? RANK.defaultProm;
      const fame = p.kind === 'lake' ? 1 : p.tags?.wikipedia ? RANK.wikipedia : p.tags?.wikidata ? RANK.wikidata : 1;
      out.push({
        peak: p,
        east: o.east, north: o.north, up: o.up,
        range: o.range, bearing: o.bearing, elevation: o.elevation,
        anchorAlt,
        anchor: { lon: a.lon, lat: a.lat },
        rank: size ? Math.atan2(size, o.range) * fame : 0,
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

/**
 * The label grid: cells of bearing and elevation, degrees, about one label
 * wide and two lines tall at this field of view. Their size is taken from
 * a ladder of √2 steps, so a small zoom keeps the cells and the names in
 * them; a cell is a patch of sky, not of screen, so turning the view moves
 * the names with the mountains instead of dealing them out anew.
 */
export function labelCells(cam: Camera, opt: Pick<LayoutOptions, 'width' | 'height' | 'lineHeight'>): { bearing: number; elevation: number } {
  const DEG = Math.PI / 180;
  const vfov = cam.fov, hfov = (2 * Math.atan(Math.tan((vfov * DEG) / 2) * (opt.width / opt.height))) / DEG;
  const onLadder = (deg: number) => LABEL_GRID.step ** Math.round(Math.log(deg) / Math.log(LABEL_GRID.step));
  return {
    bearing: onLadder((hfov * LABEL_GRID.width * opt.lineHeight) / opt.width),
    elevation: onLadder((vfov * LABEL_GRID.height * opt.lineHeight) / opt.height),
  };
}

/**
 * Screen placement. Each cell of the label grid (labelCells) names one
 * feature: the best-ranked visible one in it, a summit before a lake (the
 * tessellation of Raposo, Brewer and Stanislawski 2013: a retained summit
 * has room for its label). When that one is out of the frame the cell stays
 * unnamed rather than go to the next for as long as it takes to pan there;
 * when it is in the frame but cannot be placed (no room, under a panel), the
 * next in the cell is tried. Zooming in makes the cells smaller, so more
 * summits get their names, as a telescope does in PeakFinder. Labels are
 * stacked upwards from their summit; one that finds no free slot is dropped
 * rather than allowed to overlap.
 *
 * Returns what was placed and how many visible features are in the frame.
 */
export function layout(
  targets: LabelTarget[], cam: Camera, opt: LayoutOptions,
): { placed: PlacedLabel[]; inFrame: number } {
  const ndc = new Float32Array(3);
  const placed: PlacedLabel[] = [];
  const margin = 4;
  const blocked = opt.blocked ?? [];

  /** Anchor in CSS pixels, or null behind the camera. */
  const project = (t: LabelTarget): { x: number; y: number } | null => {
    const w = cam.project(t.east, t.north, t.up, ndc);
    if (w <= 0) return null;
    return { x: (ndc[0] * 0.5 + 0.5) * opt.width, y: (1 - (ndc[1] * 0.5 + 0.5)) * opt.height };
  };
  const at = new Map<LabelTarget, { x: number; y: number } | null>();
  const where = (t: LabelTarget) => {
    let p = at.get(t);
    if (p === undefined) { p = project(t); at.set(t, p); }
    return p;
  };
  const framed = (t: LabelTarget): boolean => {
    const p = where(t);
    return !!p && p.x >= 0 && p.x <= opt.width && p.y >= 0 && p.y <= opt.height;
  };

  // One label per summit or lake: among its visible anchors, the most
  // preferred one that is in the frame (its main point if that shows there,
  // else the first spare spot that does). A long lake whose centre is left
  // of the frame is named on the end that is in it.
  const chosen = new Map<string, LabelTarget>();
  for (const t of targets) {
    if (!t.visible) continue;
    const c = chosen.get(t.peak.id);
    if (!c) { chosen.set(t.peak.id, t); continue; }
    const tIn = framed(t), cIn = framed(c);
    if (tIn === cIn ? t.spot < c.spot : tIn) chosen.set(t.peak.id, t);
  }

  // The cells: every visible feature goes into the cell of sky it stands in, best first.
  const size = labelCells(cam, opt);
  const better = (a: LabelTarget, b: LabelTarget) =>
    (a.peak.kind === 'lake' ? 1 : 0) - (b.peak.kind === 'lake' ? 1 : 0)
    || effectiveRank(b) - effectiveRank(a) || a.range - b.range;
  const cells = new Map<string, LabelTarget[]>();
  let inFrame = 0;
  for (const t of chosen.values()) {
    const bearing = ((t.bearing % 360) + 360) % 360;
    const key = `${Math.floor(bearing / size.bearing)}:${Math.floor((t.elevation + 90) / size.elevation)}`;
    const list = cells.get(key);
    if (list) list.push(t); else cells.set(key, [t]);
    if (framed(t)) inFrame++;
  }

  // The cells in the order they are filled: those named last time first, as
  // they were, then by their best feature.
  const before = new Map<string, number>();
  (opt.previous ?? []).forEach((p, i) => before.set(p.target.peak.id, i));
  const order: { list: LabelTarget[]; was: number }[] = [];
  for (const list of cells.values()) {
    list.sort(better);
    if (!framed(list[0])) continue;                      // its best is out of the frame: unnamed for now
    let was = Infinity;
    for (const t of list) { const i = before.get(t.peak.id); if (i !== undefined && i < was) was = i; }
    order.push({ list, was });
  }
  order.sort((a, b) => a.was - b.was || better(a.list[0], b.list[0]));

  const lakeMax = Math.max(1, Math.round(opt.maxLabels * RANK.lakeShare));
  let lakes = 0;
  const hits = (bx: number, by: number, bw: number, bh: number) =>
    placed.some((b) => bx < b.bx + b.bw + opt.gap && bx + bw + opt.gap > b.bx && by < b.by + b.bh + margin && by + bh + margin > b.by)
    || blocked.some((r) => bx < r.x + r.w + margin && bx + bw + margin > r.x && by < r.y + r.h + margin && by + bh + margin > r.y);

  for (const { list } of order) {
    if (placed.length >= opt.maxLabels) break;
    for (const t of list) {
      if (!framed(t)) continue;
      if (t.peak.kind === 'lake' && lakes >= lakeMax) continue;
      if (t.settle && t.settledFor !== (opt.drawnKey ?? '')) {
        // In the frame for the first time, or drawn anew: onto the summit as the mesh draws it.
        Object.assign(t, t.settle(t));
        t.settledFor = opt.drawnKey ?? '';
        at.delete(t);
      }
      const p = where(t);
      if (!p) continue;
      const ax = p.x, ay = p.y;
      // A summit under a panel is not named: its pin would point under the panel.
      if (blocked.some((r) => ax >= r.x && ax <= r.x + r.w && ay >= r.y && ay <= r.y + r.h)) continue;

      const detailed = placed.length < opt.detailed;
      const lines = detailed
        ? [t.peak.name, `${fmtEle(t.peak) || (t.peak.kind === 'lake' ? `${Math.round(t.anchorAlt)} m` : '')} · ${fmtRange(t.range)}`]
        : [t.peak.name];
      const bw = Math.max(...lines.map((s, li) => opt.measure(s, li === 0))) + 12;
      const bh = lines.length * opt.lineHeight + 6;

      // Where the box may stand: centred over the summit, or, when a panel
      // is in the way there, beside the panel as long as it is still over
      // the summit. At each place it is stacked upwards from the summit; a
      // summit too close to the top edge keeps its label at the top and
      // stacks downwards instead, because the highest peak in view is the
      // last one that should lose its name. Below the summit is the last resort.
      const centred = Math.min(Math.max(ax - bw / 2, 2), opt.width - bw - 2);
      const columns = [centred];
      for (const r of blocked) {
        if (!(centred < r.x + r.w + margin && centred + bw + margin > r.x)) continue;
        for (const x of [r.x + r.w + margin, r.x - margin - bw]) {
          if (x >= 2 && x + bw <= opt.width - 2 && ax >= x && ax <= x + bw) columns.push(x);
        }
      }
      const stack = (x: number, from: number, dir: number): number | null => {
        let y = from;
        for (let attempt = 0; attempt < 26; attempt++) {
          if (y < 2 || y + bh > opt.height - 2) return null;
          if (!hits(x, y, bw, bh)) return y;
          y += dir * (opt.lineHeight + opt.gap);
        }
        return null;
      };
      let bx = centred, by: number | null = null;
      const above = ay - 14 - bh;
      for (const x of columns) {
        by = above < 2 ? stack(x, 2, 1) : stack(x, above, -1);
        if (by !== null) { bx = x; break; }
      }
      if (by === null && above >= 2) by = stack(centred, ay + 14, 1);
      if (by === null) continue;

      placed.push({ target: t, ax, ay, bx, by, bw, bh, lines });
      if (t.peak.kind === 'lake') lakes++;
      break;                                             // the cell is named
    }
  }
  return { placed, inFrame };
}

/** The labels `layout` places. */
export function layoutLabels(targets: LabelTarget[], cam: Camera, opt: LayoutOptions): PlacedLabel[] {
  return layout(targets, cam, opt).placed;
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
