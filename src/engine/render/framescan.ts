/**
 * What a zoomed frame shows of the ground, by distance.
 *
 * The mesh is rings around the standpoint, and zoomed in there are far too
 * few of them to lie a few pixels apart everywhere: at 3.2° a pixel is
 * 1.5 m of ground at 16 km. So they have to go where the frame shows
 * ground. They used to go where the centre of the view met it (one dense
 * band, mesh.ts bandFor): a mountain beside the centre was drawn with
 * rings 200–300 m apart, its crest wherever two of them happened to fall,
 * and differently again when the centre moved to the next ridge.
 *
 * The scan sorts the distance into fixed bins, a fortieth of the range
 * wide. Rays across the frame's bearings are marched outward; a sample is
 * in the frame when its elevation angle lies between the frame's lower and
 * upper edge, and seen when no nearer sample of its ray stood higher. Each
 * bin gets a class (nothing of it in the frame, in the frame but hidden by
 * nearer ground, seen) and a need: how far the ray's skyline climbs within
 * it, inside the frame, as the tangent of the elevation angle, the most of
 * any ray. That is the height of the picture that comes into view there.
 * Rings as far apart as a pixel or two of that (mesh.ts ringTable) leave a
 * crest at most that much too low, wherever it stands, and a plain or a
 * lake in view takes the rows of the screen it fills, not rings by the
 * metre of its depth.
 */
import { curvatureDrop, destination, localRadius } from '../core/geodesy';
import { HeightField } from '../core/heightfield';

const DEG = Math.PI / 180;

export const SCAN = {
  /** Where the first bin begins, metres: the innermost ring of the mesh. */
  r0: 2,
  /** A bin ends this much further out than it begins. */
  ratio: 1.025,
  /** Bearings marched across the frame. */
  rays: 25,
  /** Samples a bin on every ray, staggered from ray to ray. */
  samples: 2,
  /** What is seen counts for this many bins to either side as well. */
  dilate: 1,
  /** FrameScanner scans this share of the frame more on every side, and keeps the scan while the frame stays inside. */
  margin: 0.25,
} as const;

const LOG_RATIO = Math.log(SCAN.ratio);

/** Where bin `b` begins, metres. */
export function scanStart(b: number): number {
  return SCAN.r0 * Math.exp(b * LOG_RATIO);
}

/** The bin a ground range lies in. */
export function scanBin(r: number): number {
  return Math.max(0, Math.floor(Math.log(r / SCAN.r0) / LOG_RATIO + 1e-9));
}

/** How many bins reach out to `maxRange`. */
export function scanBins(maxRange: number): number {
  return Math.max(1, Math.ceil(Math.log(maxRange / SCAN.r0) / LOG_RATIO - 1e-9));
}

/** Bearings from az0 to az1 (degrees, az1 > az0) and elevation angles from el0 to el1 (degrees above the horizon). */
export interface FrameBox { az0: number; az1: number; el0: number; el1: number }

/** Not in the frame, in it but hidden, seen. */
export type ScanClass = 0 | 1 | 2;

/** What a frame shows of the ground, bin by bin (scanStart). */
export interface FrameView {
  /** ScanClass of each bin; what is seen reaches SCAN.dilate bins to either side. */
  classes: Uint8Array;
  /** The tangent of elevation angle that comes into view in each bin: the frame's height it fills. */
  need: Float32Array;
}

/**
 * A scan in the making: a ray a step, so that it can be spread over frames.
 */
export class ScanJob {
  private readonly found: Uint8Array;
  private readonly need: Float32Array;
  /** One ray's climb in each bin. */
  private readonly climb: Float32Array;
  private readonly rays: number;
  private readonly dilate: number;
  private readonly radius: number;
  private readonly tanLo: number;
  private readonly tanHi: number;
  private readonly maxRange: number;
  private k = 0;

  constructor(
    private readonly hf: HeightField, private readonly eyeAlt: number, readonly box: FrameBox,
    opt: { rays?: number; dilate?: number } = {},
  ) {
    this.rays = Math.max(2, opt.rays ?? SCAN.rays);
    this.dilate = opt.dilate ?? SCAN.dilate;
    this.maxRange = hf.maxRange;
    this.found = new Uint8Array(scanBins(Math.max(this.maxRange, SCAN.r0 * SCAN.ratio)));
    this.need = new Float32Array(this.found.length);
    this.climb = new Float32Array(this.found.length);
    this.radius = localRadius(hf.lat);
    this.tanLo = Math.tan(Math.max(-89, box.el0) * DEG);
    this.tanHi = Math.tan(Math.min(89, box.el1) * DEG);
  }

  /** Marches the next ray; true when all are done. */
  step(): boolean {
    if (this.k >= this.rays || !(this.maxRange > SCAN.r0)) return true;
    const { hf, found, need, climb, box, maxRange, radius, tanLo, tanHi, eyeAlt } = this, k = this.k++;
    const az = box.az0 + ((box.az1 - box.az0) * k) / (this.rays - 1);
    // Each ray samples its bins at other places, so that a crest narrower than a bin is met by some.
    const jitter = (k * 0.6180339887) % 1;
    let top = -Infinity, before = 0;
    climb.fill(0);
    for (let b = 0; b < found.length; b++) {
      for (let i = 0; i < SCAN.samples; i++) {
        const r = Math.min(maxRange, scanStart(b + (i + jitter) / SCAN.samples));
        const p = destination(hf.lon, hf.lat, az, r, radius);
        const rise = (hf.height(p.lon, p.lat, r) - eyeAlt - curvatureDrop(r, radius)) / r;
        const seen = rise > top;
        if (seen) {
          // The skyline climbed from `top` to here, somewhere since the sample before: what of that
          // lies in the frame comes into view in this bin, or in the one that sample was in.
          const gain = Math.min(rise, tanHi) - Math.max(top, tanLo);
          if (gain > 0) {
            climb[b] += gain;
            if (before !== b) climb[before] += gain;
          }
          top = rise;
        }
        before = b;
        if (rise < tanLo || rise > tanHi) continue;
        const c = seen ? 2 : 1;
        if (c > found[b]) found[b] = c;
      }
    }
    for (let b = 0; b < need.length; b++) if (climb[b] > need[b]) need[b] = climb[b];
    return this.k >= this.rays;
  }

  /** What the frame shows, once every ray is marched: what is seen reaches `dilate` bins to either side. */
  view(): FrameView {
    const { found, dilate } = this;
    const classes = found.slice();
    for (let b = 0; dilate > 0 && b < found.length; b++) {
      if (found[b] !== 2) continue;
      for (let d = -dilate; d <= dilate; d++) if (b + d >= 0 && b + d < found.length) classes[b + d] = 2;
    }
    return { classes, need: this.need.slice() };
  }
}

/**
 * What a box of bearings and elevation angles shows of the ground, as
 * seen from `eyeAlt` over the height field's origin: for every bin the
 * highest class and the largest need any ray found in it.
 */
export function frameScan(
  hf: HeightField, eyeAlt: number, box: FrameBox,
  opt: { rays?: number; dilate?: number } = {},
): FrameView {
  const job = new ScanJob(hf, eyeAlt, box, opt);
  while (!job.step()) { /* every ray */ }
  return job.view();
}

const inside = (f: FrameBox, b: FrameBox) => f.az0 >= b.az0 && f.az1 <= b.az1 && f.el0 >= b.el0 && f.el1 <= b.el1;
const grown = (f: FrameBox, by: number): FrameBox => {
  const ma = (f.az1 - f.az0) * by, me = (f.el1 - f.el0) * by;
  return { az0: f.az0 - ma, az1: f.az1 + ma, el0: f.el0 - me, el1: f.el1 + me };
};

/**
 * Scans again only when it has to, and then over several frames. A scan
 * covers the frame and a margin around it; while the frame stays within
 * half that margin, and has not shrunk to under two thirds of what was
 * scanned (zoomed in: the scan would call far more seen than the frame
 * shows), the scan stands: panning within a mountain's width costs
 * nothing and moves no ring. Past half the margin the next scan begins,
 * `budgetMs` of it a call and a ray at least; the old scan is handed
 * out until the new one is whole.
 */
export class FrameScanner {
  private box: FrameBox | null = null;
  private frame: FrameBox | null = null;
  private found: FrameView | null = null;
  private key = '';
  private place = '';
  private job: ScanJob | null = null;
  private jobKey = '';
  private jobFrame: FrameBox | null = null;
  /** How many scans were made. */
  scans = 0;

  /** Whether a scan is under way. */
  get scanning(): boolean { return this.job !== null; }

  /**
   * What a frame shows; null while the first scan of a place is still
   * running. `stamp` names the terrain's state: another stamp, another scan.
   */
  scan(hf: HeightField, eyeAlt: number, frame: FrameBox, stamp: string, budgetMs = Infinity): FrameView | null {
    const place = `${hf.lon},${hf.lat}`;
    const key = `${stamp}|${place},${Math.round(eyeAlt * 10)}`;
    if (place !== this.place) { this.found = null; this.job = null; this.place = place; }
    const f = this.frame;
    if (this.found && this.box && f && key === this.key && inside(frame, grown(f, SCAN.margin / 2))
      && frame.az1 - frame.az0 > (f.az1 - f.az0) * 0.67 && frame.el1 - frame.el0 > (f.el1 - f.el0) * 0.67) {
      this.job = null;
      return this.found;
    }
    // A scan for this frame, unless one is under way that still holds it.
    if (!this.job || this.jobKey !== key || !this.jobFrame || !inside(frame, grown(this.jobFrame, SCAN.margin / 2))) {
      this.jobFrame = { ...frame };
      this.jobKey = key;
      this.job = new ScanJob(hf, eyeAlt, grown(frame, SCAN.margin));
    }
    const t0 = budgetMs === Infinity ? 0 : performance.now();
    let done = this.job.step();
    while (!done && (budgetMs === Infinity || performance.now() - t0 < budgetMs)) done = this.job.step();
    if (!done) return this.found;
    this.found = this.job.view();
    this.box = this.job.box;
    this.frame = this.jobFrame;
    this.key = key;
    this.job = null;
    this.scans++;
    return this.found;
  }

  /** Forget the scan: the next call scans. */
  reset() { this.found = null; this.job = null; }
}
