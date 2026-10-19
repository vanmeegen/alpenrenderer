/**
 * Which summits the terrain hides.
 *
 * The WebGL build answered this on the GPU, by drawing one point per summit
 * into a small buffer and reading it back every frame. That read-back is a
 * pipeline stall, and it only ever answered for the current frustum, so the
 * summit list could not say what lay behind you.
 *
 * This walks the elevation model instead: march along the great circle towards
 * each summit, track the highest apparent elevation angle on the way, and the
 * summit is visible if it clears it. It depends on where you stand, not where
 * you point, so it runs once per position rather than once per frame — and it
 * uses the same curvature and refraction terms as the renderer, so the two
 * cannot disagree about the horizon.
 */

import { curvatureDrop, destination, localRadius, REFRACTION_K } from './geodesy';
import { HeightField } from './heightfield';
import { LabelTarget, pinAt } from './labels';

export interface HorizonOptions {
  /** Samples along each sightline. */
  steps: number;
  /**
   * Slack in degrees. A catalogued summit sits above the DEM's rounded-off
   * version of itself, and the last few samples of a sightline climb the peak
   * being tested, so a little tolerance keeps real summits from hiding behind
   * their own slopes.
   */
  tolerance: number;
  k: number;
  /**
   * Where the march stops short of the anchor: this fraction of the range,
   * or `endPosts` posts of the level read there, whichever is longer. The
   * DEM flattens a summit into a couple of posts; a sample inside the
   * summit's own cell, or the cell before it that the bilinear surface
   * pulls up, stands a few tenths of a degree "higher" than the anchor
   * without hiding anything (the Gschöllkopf from the Mauritzalm, 367 m
   * away: 28.6° against 28.0° with 13 m posts).
   */
  endFrac: number;
  endPosts: number;
  /**
   * A summit a little behind the visible edge of its own mountain is seen as
   * that mountain (the Haidachstellwand from the Mauritzalm: the summit point
   * 24 m higher but 114 m behind the top edge of the wall, 0.4° under the
   * sightline). The edge counts as the summit's own when the march's maximum
   * lies in the last `crestFrom` of the way or within `crestNear` metres of
   * the anchor, the summit is at most `crestDrop` degrees below it, and the
   * ground between edge and summit never dips more than `crestDip` metres
   * below the edge: a shoulder, not a separate ridge with a valley behind.
   * The pin then goes onto the edge, the label keeps the summit's range.
   */
  crestFrom: number;
  crestNear: number;
  crestDrop: number;
  crestDip: number;
}

export const DEFAULT_HORIZON: HorizonOptions = {
  steps: 96,
  tolerance: 0.05,
  k: REFRACTION_K,
  endFrac: 0.015,
  endPosts: 2,
  crestFrom: 0.8,
  crestNear: 300,
  crestDrop: 1.5,
  crestDip: 15,
};

/** What the march along a sightline found: the highest apparent elevation on the way and where. */
export interface March {
  maxElev: number;
  /** Ground range of the highest sample, metres. */
  rMax: number;
  /** Its height, metres. */
  hMax: number;
  /** Ground range of the sample before the highest one, metres. */
  rPrev: number;
}

/**
 * Sets `visible` on every target. Returns how many are visible.
 *
 * Cost is steps × targets DEM lookups — a few tens of thousands, a couple of
 * milliseconds, once per position.
 */
/** Apparent elevation angle, degrees, of a point `h` metres high at ground range `r`. */
function elevationAt(h: number, r: number, eyeAlt: number, radius: number, k: number): number {
  return Math.atan2(h - eyeAlt - curvatureDrop(r, radius, k), r) * (180 / Math.PI);
}

/**
 * Marches the DEM towards a target and reports the highest apparent
 * elevation on the way. It stops short of the anchor (HorizonOptions.endFrac,
 * endPosts) so the summit's own cell never counts.
 */
export function march(t: LabelTarget, hf: HeightField, eyeAlt: number, opt: HorizonOptions, radius: number): March {
  const range = t.range;
  // Geometric spacing: near ground matters far more than the last kilometre,
  // and it keeps the step proportional to the DEM resolution at that range.
  const r0 = Math.min(80, range * 0.02);
  const end = Math.max(r0 * 1.001, range - Math.max(opt.endFrac * range, opt.endPosts * hf.resAt(range)));
  const ratio = Math.log(end / r0) / (opt.steps - 1);
  const m: March = { maxElev: -90, rMax: 0, hMax: 0, rPrev: r0 };
  let prev = r0;
  for (let i = 0; i < opt.steps; i++) {
    const r = r0 * Math.exp(i * ratio);
    const p = destination(hf.lon, hf.lat, t.bearing, r, radius);
    const h = hf.height(p.lon, p.lat, r);
    const elev = elevationAt(h, r, eyeAlt, radius, opt.k);
    if (elev > m.maxElev) { m.maxElev = elev; m.rMax = r; m.hMax = h; m.rPrev = prev; }
    prev = r;
  }
  return m;
}

/**
 * The visible edge of a summit's own mountain, when that is what hides the
 * summit (HorizonOptions.crestFrom..crestDip); null when a separate ridge
 * does, or the summit is well below its rim. The ground between the march's
 * highest sample and the anchor is walked again post by post: the march's
 * samples are up to a spacing apart (1.8 km at 30 km), which both misplaces
 * the edge and lets a valley slip between two of them.
 */
export function ownCrest(
  t: LabelTarget, m: March, hf: HeightField, eyeAlt: number, opt: HorizonOptions, radius: number,
): { lon: number; lat: number; h: number } | null {
  const range = t.range;
  if (m.rMax < Math.min(opt.crestFrom * range, range - opt.crestNear)) return null;
  const from = Math.max(1, m.rPrev), to = range;
  const step = Math.max(hf.resAt(m.rMax), (to - from) / 128);
  const n = Math.max(1, Math.ceil((to - from) / step));
  let crest = { r: m.rMax, h: m.hMax, elev: m.maxElev };
  const walked: { r: number; h: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const r = Math.min(to, from + i * step);
    const p = destination(hf.lon, hf.lat, t.bearing, r, radius);
    const h = hf.height(p.lon, p.lat, r);
    walked.push({ r, h });
    const elev = elevationAt(h, r, eyeAlt, radius, opt.k);
    if (elev > crest.elev) crest = { r, h, elev };
  }
  let lowest = crest.h;
  for (const w of walked) if (w.r >= crest.r && w.h < lowest) lowest = w.h;
  if (crest.h - lowest > opt.crestDip) return null;
  if (crest.elev - t.elevation > opt.crestDrop) return null;
  const p = destination(hf.lon, hf.lat, t.bearing, crest.r, radius);
  return { lon: p.lon, lat: p.lat, h: crest.h };
}

/**
 * Decides one target: visible when the summit stands above everything in
 * front of it, or when what stands in front is the visible edge of its own
 * mountain; then the pin moves onto that edge.
 */
function decide(t: LabelTarget, hf: HeightField, eyeAlt: number, opt: HorizonOptions, radius: number): boolean {
  if (t.range < 60) return true;
  const m = march(t, hf, eyeAlt, opt, radius);
  if (t.elevation >= m.maxElev - opt.tolerance) return true;
  if (t.peak.kind === 'lake') return false;
  const edge = ownCrest(t, m, hf, eyeAlt, opt, radius);
  if (!edge) return false;
  pinAt(t, edge, { lon: hf.lon, lat: hf.lat, alt: eyeAlt });
  return true;
}

/**
 * The sightline check spread over frames. Forty thousand catalogue summits
 * take a second or two of DEM marches; done in one go that is a frozen app
 * at every level that arrives. `step` decides targets in order (nearest
 * first, as `buildTargets` sorts them) until the budget is spent,
 * and the render loop calls it again next frame. Undecided targets read as
 * not visible, so labels appear as they are confirmed rather than all at once.
 */
export class VisibilityJob {
  private i = 0;
  private readonly radius: number;
  /** Summits confirmed visible so far (a lake's spare spots are not counted). */
  visible = 0;

  constructor(
    private readonly targets: LabelTarget[],
    private readonly hf: HeightField,
    private readonly eyeAlt: number,
    private readonly opt: HorizonOptions = DEFAULT_HORIZON,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.radius = localRadius(hf.lat);
    for (const t of targets) { t.visible = false; t.decided = false; }
  }

  get done(): boolean { return this.i >= this.targets.length; }

  /** Decides targets until `budgetMs` has passed; returns whether all are decided. */
  step(budgetMs: number): boolean {
    const t0 = this.now();
    while (this.i < this.targets.length) {
      const t = this.targets[this.i++];
      t.visible = decide(t, this.hf, this.eyeAlt, this.opt, this.radius);
      t.decided = true;
      if (t.visible && t.spot === 0 && t.peak.kind !== 'lake') this.visible++;
      if (this.now() - t0 >= budgetMs) break;
    }
    return this.done;
  }
}

/** All targets at once; the number visible. */
export function computeVisibility(
  targets: LabelTarget[],
  hf: HeightField,
  eyeAlt: number,
  opt: HorizonOptions = DEFAULT_HORIZON,
): number {
  const job = new VisibilityJob(targets, hf, eyeAlt, opt, () => 0);
  job.step(Infinity);
  return job.visible;
}
