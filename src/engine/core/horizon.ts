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
  /** Bearings the horizon table holds, evenly round the compass. */
  bearings: number;
  /** Where the march begins, metres from the eye. */
  start: number;
  /**
   * Slack, metres: a summit counts as seen when it is less than `tolMetres`
   * plus `tolDrop` of the curvature drop at its range below the sightline.
   * The first is the DEM's rounding, the second what refraction moves a far
   * summit by from day to day: 2 m close by, 22 m at 100 km. (An angle, as
   * before, was 87 m at 100 km and 0.9 m at 1 km.)
   */
  tolMetres: number;
  tolDrop: number;
  k: number;
  /**
   * How far short of the anchor the summit's own ground begins: this
   * fraction of the range, or `endPosts` posts of the level read there,
   * whichever is longer. The DEM flattens a summit into a couple of posts; a
   * sample inside the summit's own cell, or the cell before it that the
   * bilinear surface pulls up, stands a few tenths of a degree "higher" than
   * the anchor without hiding anything (the Gschöllkopf from the Mauritzalm,
   * 367 m away: 28.6° against 28.0° with 13 m posts).
   */
  endFrac: number;
  endPosts: number;
  /**
   * A summit a little behind the visible edge of its own mountain is seen as
   * that mountain (the Haidachstellwand from the Mauritzalm: the summit point
   * 24 m higher but 114 m behind the top edge of the wall, 0.4° under the
   * sightline). The edge counts as the summit's own when the highest ground
   * in front lies in the last `crestFrom` of the way or within `crestNear`
   * metres of the anchor, the summit is at most `crestDrop` degrees below it,
   * and the ground between edge and summit never dips more than `crestDip`
   * metres below the edge: a shoulder, not a separate ridge with a valley
   * behind. The pin then goes onto the edge, the label keeps the summit's range.
   */
  crestFrom: number;
  crestNear: number;
  crestDrop: number;
  crestDip: number;
}

export const DEFAULT_HORIZON: HorizonOptions = {
  bearings: 2048,
  start: 2,
  tolMetres: 2,
  tolDrop: 0.03,
  k: REFRACTION_K,
  endFrac: 0.015,
  endPosts: 2,
  crestFrom: 0.8,
  crestNear: 300,
  crestDrop: 1.5,
  crestDip: 15,
};

/** The highest ground in front of a summit, as the table holds it: its apparent elevation and where it is. */
export interface March {
  maxElev: number;
  /** Ground range of the highest sample, metres. */
  rMax: number;
  /** Its height, metres. */
  hMax: number;
  /** A range safely before the highest sample, metres: where a closer look begins. */
  rPrev: number;
}

/** Apparent elevation angle, degrees, of a point `h` metres high at ground range `r`. */
function elevationAt(h: number, r: number, eyeAlt: number, radius: number, k: number): number {
  return Math.atan2(h - eyeAlt - curvatureDrop(r, radius, k), r) * (180 / Math.PI);
}

/** Posts a straight stretch of a row spans at most, so the great circle stays within a few hundredths of a post of it. */
const STRETCH = 48;
/** Growth of the first steps from the eye, where angles change fastest. */
const NEAR_GROWTH = 1.1;
/** Posts of the finest level over which the march steps geometrically before it goes post by post. */
const NEAR_POSTS = 8;

/**
 * The horizon round the eye, as far as the terrain is loaded: for each of
 * `bearings` directions the staircase of the highest apparent elevation
 * reached so far, walking outward from the eye. "Is this summit hidden?" is
 * then a look-up: the step in front of the summit's own ground.
 *
 * A row is walked once, when a summit first needs it, and every post on the
 * way counts: from two metres out (a bank ten metres away is the whole
 * foreground of the picture, and hides what it hides there), in steps a
 * tenth longer each while the ground is near, then post by post on each
 * level as far as it reaches. The samples lie on the lines through the post
 * centres that the row crosses, so a ridge one post wide is read at its full
 * height and not somewhere down its side. (The march per summit that this
 * replaces took 96 samples however far the summit: 6 km apart at 100 km.)
 */
export class HorizonTable {
  /** Posts read so far, and rows walked. */
  samples = 0;
  rowsBuilt = 0;
  private readonly rows: (Float32Array | null)[];
  private readonly radius: number;
  private readonly twoREff: number;

  constructor(
    private readonly hf: HeightField,
    private readonly eyeAlt: number,
    private readonly opt: HorizonOptions = DEFAULT_HORIZON,
  ) {
    this.rows = new Array<Float32Array | null>(opt.bearings).fill(null);
    this.radius = localRadius(hf.lat);
    this.twoREff = (2 * this.radius) / (1 - opt.k);
  }

  /** The staircase at bearing index `i`: pairs of range and tan(elevation), both rising. */
  private row(i: number): Float32Array {
    return this.rows[i] ?? (this.rows[i] = this.walk((i * 360) / this.opt.bearings));
  }

  private walk(bearing: number): Float32Array {
    const { hf, eyeAlt, radius, twoREff } = this;
    const out: number[] = [];
    let best = -Infinity, count = 0;
    const see = (r: number, h: number) => {
      count++;
      const t = (h - eyeAlt - (r * r) / twoREff) / r;
      if (t > best) { best = t; out.push(r, t); }
    };
    const levels = hf.eyeLevels().filter((l) => l.filled && l.maxRange > 0);
    if (levels.length) {
      // Near the eye: steps a tenth longer each, on the surface as height() gives it.
      const nearEnd = Math.min(NEAR_POSTS * levels[0].res, levels[0].maxRange);
      let r = this.opt.start;
      for (; r < nearEnd; r *= NEAR_GROWTH) {
        const p = destination(hf.lon, hf.lat, bearing, r, radius);
        see(r, hf.height(p.lon, p.lat, r));
      }
      // Then post by post, each level as far as it reaches.
      let from = nearEnd;
      for (const l of levels) {
        if (l.maxRange <= from) continue;
        const stretch = STRETCH * l.res;
        for (let r0 = from; r0 < l.maxRange; r0 += stretch) {
          const r1 = Math.min(l.maxRange, r0 + stretch);
          const a = destination(hf.lon, hf.lat, bearing, r0, radius), b = destination(hf.lon, hf.lat, bearing, r1, radius);
          const pa = hf.project(l, a.lon, a.lat), pb = hf.project(l, b.lon, b.lat);
          const du = pb.u - pa.u, dv = pb.v - pa.v;
          // The lines through the post centres along the axis the row mostly runs on: u or v = k + 0.5.
          const alongU = Math.abs(du) >= Math.abs(dv);
          const s0 = alongU ? pa.u : pa.v, s1 = alongU ? pb.u : pb.v;
          const dir = s1 >= s0 ? 1 : -1;
          let k = dir > 0 ? Math.ceil(s0 - 0.5) : Math.floor(s0 - 0.5);
          for (; dir > 0 ? k + 0.5 < s1 : k + 0.5 > s1; k += dir) {
            const t = (k + 0.5 - s0) / (s1 - s0);
            if (t < 0) continue;
            // Across the other axis: between the two posts the row passes there.
            const c = (alongU ? pa.v + t * dv : pa.u + t * du) - 0.5;
            const c0 = Math.floor(c), f = c - c0;
            let h0: number, h1: number;
            if (alongU) {
              if (k < 0 || k >= l.w || c0 < 0 || c0 + 1 >= l.h) continue;
              h0 = l.raw[c0 * l.w + k]; h1 = l.raw[(c0 + 1) * l.w + k];
            } else {
              if (k < 0 || k >= l.h || c0 < 0 || c0 + 1 >= l.w) continue;
              h0 = l.raw[k * l.w + c0]; h1 = l.raw[k * l.w + c0 + 1];
            }
            see(r0 + t * (r1 - r0), (h0 + (h1 - h0) * f) * l.quant + l.bias);
          }
        }
        from = l.maxRange;
      }
    }
    this.samples += count;
    this.rowsBuilt++;
    return Float32Array.from(out);
  }

  /** The last step of a row before `range`: its index, or -1 when the row begins beyond it. */
  private static last(row: Float32Array, range: number): number {
    let lo = 0, hi = row.length / 2 - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (row[2 * mid] < range) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return at;
  }

  /**
   * The highest ground nearer than `range` towards `bearing` (degrees): the
   * tangent of its apparent elevation, between the two rows the bearing lies
   * between, and the range of the higher of the two. -Infinity when nothing
   * is nearer.
   */
  before(bearing: number, range: number): { tan: number; r: number } {
    const n = this.opt.bearings;
    const x = ((((bearing % 360) + 360) % 360) / 360) * n;
    const i = Math.floor(x) % n, f = x - Math.floor(x);
    const a = this.row(i), b = this.row((i + 1) % n);
    const ia = HorizonTable.last(a, range), ib = HorizonTable.last(b, range);
    if (ia < 0 && ib < 0) return { tan: -Infinity, r: 0 };
    if (ia < 0) return { tan: b[2 * ib + 1], r: b[2 * ib] };
    if (ib < 0) return { tan: a[2 * ia + 1], r: a[2 * ia] };
    const ta = a[2 * ia + 1], tb = b[2 * ib + 1];
    return { tan: ta + (tb - ta) * f, r: ta >= tb ? a[2 * ia] : b[2 * ib] };
  }

  /** The skyline towards `bearing`: the tangent of the highest apparent elevation of all the ground there. */
  skyline(bearing: number): number {
    return this.before(bearing, Infinity).tan;
  }
}

/**
 * The visible edge of a summit's own mountain, when that is what hides the
 * summit (HorizonOptions.crestFrom..crestDip); null when a separate ridge
 * does, or the summit is well below its rim. The ground between the highest
 * point in front and the anchor is walked again post by post along the
 * summit's own bearing: the table's rows lie beside it, and the walk finds
 * the edge itself and any valley behind it.
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
function decide(
  t: LabelTarget, table: HorizonTable, hf: HeightField, eyeAlt: number, opt: HorizonOptions, radius: number,
): boolean {
  t.skyline = false;
  if (t.range < 60) return true;
  const DEG = Math.PI / 180;
  const range = t.range;
  // Slack as an angle at this range, and where the summit's own ground begins.
  const slack = (opt.tolMetres + opt.tolDrop * curvatureDrop(range, radius, opt.k)) / range;
  const own = range - Math.max(opt.endFrac * range, opt.endPosts * hf.resAt(range));
  const front = table.before(t.bearing, own);
  // With nothing behind it that stands higher than all the ground up to and
  // including its own, the summit is against the sky.
  const sky = () => table.skyline(t.bearing) <= table.before(t.bearing, 2 * range - own).tan + slack;
  if (Math.tan(t.elevation * DEG) >= front.tan - slack) { t.skyline = sky(); return true; }
  if (t.peak.kind === 'lake') return false;
  const m: March = {
    maxElev: Math.atan(front.tan) / DEG,
    rMax: front.r,
    hMax: eyeAlt + front.tan * front.r + curvatureDrop(front.r, radius, opt.k),
    rPrev: Math.max(1, front.r - 2 * hf.resAt(front.r)),
  };
  const edge = ownCrest(t, m, hf, eyeAlt, opt, radius);
  if (!edge) return false;
  pinAt(t, edge, { lon: hf.lon, lat: hf.lat, alt: eyeAlt });
  t.skyline = sky();
  return true;
}

/**
 * The sightline check spread over frames. Forty thousand catalogue summits
 * take a second or two of DEM marches; done in one go that is a frozen app
 * at every level that arrives. `step` decides targets in order (nearest
 * first, as `buildTargets` sorts them) until the budget is spent,
 * and the render loop calls it again next frame. Undecided targets read as
 * they did in `previous`, the targets this set replaces (a level arrived, the
 * eye went up a metre): what was seen stays seen until it is decided anew,
 * so a rebuild does not blank the labels. With nothing before, undecided is
 * not visible, and labels appear as they are confirmed.
 */
export class VisibilityJob {
  private i = 0;
  private readonly radius: number;
  /** Summits confirmed visible so far (a lake's spare spots are not counted). */
  visible = 0;
  /** The horizon round the eye that the targets are held against; its rows are walked as targets need them. */
  readonly table: HorizonTable;

  constructor(
    private readonly targets: LabelTarget[],
    private readonly hf: HeightField,
    private readonly eyeAlt: number,
    private readonly opt: HorizonOptions = DEFAULT_HORIZON,
    private readonly now: () => number = () => performance.now(),
    previous: LabelTarget[] = [],
  ) {
    this.radius = localRadius(hf.lat);
    this.table = new HorizonTable(hf, eyeAlt, opt);
    const seen = new Map<string, boolean>();
    for (const p of previous) if (p.visible) seen.set(`${p.peak.id}:${p.spot}`, !!p.skyline);
    for (const t of targets) {
      const was = seen.get(`${t.peak.id}:${t.spot}`);
      t.visible = was !== undefined;
      t.skyline = !!was;
      t.decided = false;
      if (t.visible && VisibilityJob.counts(t)) this.visible++;
    }
  }

  /** Whether a target counts among the visible summits: its main point, and not a lake. */
  private static counts(t: LabelTarget): boolean {
    return t.spot === 0 && t.peak.kind !== 'lake';
  }

  get done(): boolean { return this.i >= this.targets.length; }
  /** How many targets are decided so far: changes whenever a label may have appeared or moved. */
  get decided(): number { return this.i; }

  /** Decides targets until `budgetMs` has passed; returns whether all are decided. */
  step(budgetMs: number): boolean {
    const t0 = this.now();
    while (this.i < this.targets.length) {
      const t = this.targets[this.i++];
      const was = t.visible;
      t.visible = decide(t, this.table, this.hf, this.eyeAlt, this.opt, this.radius);
      t.decided = true;
      if (t.visible !== was && VisibilityJob.counts(t)) this.visible += t.visible ? 1 : -1;
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
