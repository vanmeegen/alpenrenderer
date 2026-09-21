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
import type { LabelTarget } from './labels';

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
}

export const DEFAULT_HORIZON: HorizonOptions = {
  steps: 96,
  tolerance: 0.05,
  k: REFRACTION_K,
};

/**
 * Sets `visible` on every target. Returns how many are visible.
 *
 * Cost is steps × targets DEM lookups — a few tens of thousands, a couple of
 * milliseconds, once per position.
 */
/** Decides one target's sightline; true when the summit stands above everything in front of it. */
function sightlineClear(t: LabelTarget, hf: HeightField, eyeAlt: number, opt: HorizonOptions, radius: number): boolean {
  const range = t.range;
  if (range < 60) return true;
  // Geometric spacing: near ground matters far more than the last kilometre,
  // and it keeps the step proportional to the DEM resolution at that range.
  const r0 = Math.min(80, range * 0.02);
  const ratio = Math.log((range * 0.985) / r0) / (opt.steps - 1);
  let maxElev = -90;
  for (let i = 0; i < opt.steps; i++) {
    const r = r0 * Math.exp(i * ratio);
    const p = destination(hf.lon, hf.lat, t.bearing, r, radius);
    const h = hf.height(p.lon, p.lat, r);
    const up = h - eyeAlt - curvatureDrop(r, radius, opt.k);
    const elev = Math.atan2(up, r) * (180 / Math.PI);
    if (elev > maxElev) maxElev = elev;
  }
  return t.elevation >= maxElev - opt.tolerance;
}

/**
 * The sightline check spread over frames. Forty thousand catalogue summits
 * take a second or two of DEM marches; done in one go that is a frozen app
 * at every level that arrives. `step` decides targets in order (most
 * important first, as `buildTargets` sorts them) until the budget is spent,
 * and the render loop calls it again next frame. Undecided targets read as
 * not visible, so labels appear as they are confirmed rather than all at once.
 */
export class VisibilityJob {
  private i = 0;
  private readonly radius: number;
  /** Targets confirmed visible so far. */
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
      t.visible = sightlineClear(t, this.hf, this.eyeAlt, this.opt, this.radius);
      t.decided = true;
      if (t.visible) this.visible++;
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
