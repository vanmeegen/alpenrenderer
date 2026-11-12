/**
 * The renderer's answer to slow frames.
 *
 * What a device class is asked to draw (app/device.ts) is a guess. While
 * the view moves, the time between drawn frames says whether the guess
 * holds: when the median of a window of them is over the budget, the frame
 * is drawn with fewer pixels, a step at a time, and at the last step what
 * is optional is left out. A view at rest is drawn once more at full
 * resolution (the viewer does that), so the picture one looks at is sharp
 * and only the one that moves is not.
 *
 * Fast again, it tries one step back after a wait. A try that fails (slow
 * again within the wait) doubles the wait, so a device that cannot do the
 * step is not asked every three seconds; one that holds resets it.
 *
 * Fed with frame times, nothing else: no clock, no GPU. That is what the
 * unit test drives.
 */

export const ADAPT = {
  /** Milliseconds between frames that count as smooth while moving: 30 a second. */
  budgetMs: 33,
  /** Over the budget by this factor is slow; under it by `fast` is fast enough to try a step back. */
  slack: 1.15,
  fast: 0.7,
  /** Frames a decision is taken on (their median). */
  window: 20,
  /** A gap longer than this between two frames is the view at rest, not a frame time. */
  pauseMs: 250,
  /** How much coarser than the device's pixels the moving frame is drawn, step by step. */
  steps: [1, 1.25, 1.5, 2],
  /** Wait before a step back is tried, and the most it grows to. */
  probeMs: 3000,
  probeMaxMs: 60000,
};

export class Adaptation {
  /** 0 = everything; one more per step down; past the last resolution step the haze rim goes. */
  private level = 0;
  private readonly times: number[] = [];
  private wait = ADAPT.probeMs;
  private probeAt = 0;
  private lastUpAt = -Infinity;
  /** A step back was taken and has not yet held for a window. */
  private onTrial = false;

  constructor(readonly enabled = true) {}

  /** The moving frame is drawn at 1/scale of the device's resolution, each way. */
  get scale(): number { return ADAPT.steps[Math.min(this.level, ADAPT.steps.length - 1)]; }
  /** Whether the haze rim is still drawn. */
  get rim(): boolean { return this.level < ADAPT.steps.length; }

  /**
   * A frame was drawn `dt` ms after the one before, at time `now` (ms).
   * Returns whether `scale` or `rim` changed.
   */
  frame(dt: number, now: number): boolean {
    if (!this.enabled) return false;
    if (dt > ADAPT.pauseMs) { this.times.length = 0; return false; }
    this.times.push(dt);
    if (this.times.length < ADAPT.window) return false;
    const sorted = this.times.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.times.length = 0;

    if (median > ADAPT.budgetMs * ADAPT.slack) {
      if (this.level >= ADAPT.steps.length) return false;
      this.level++;
      // Slow again soon after a step back: that step is not for this device, yet.
      this.wait = now - this.lastUpAt < this.wait ? Math.min(ADAPT.probeMaxMs, this.wait * 2) : ADAPT.probeMs;
      this.probeAt = now + this.wait;
      this.onTrial = false;
      return true;
    }
    if (median < ADAPT.budgetMs * ADAPT.fast && this.level > 0 && now >= this.probeAt) {
      this.level--;
      this.lastUpAt = now;
      this.probeAt = now + this.wait;
      this.onTrial = true;
      return true;
    }
    // A window without trouble after a step back: it holds, the next try comes after the short wait again.
    if (this.onTrial) {
      this.onTrial = false;
      this.wait = ADAPT.probeMs;
      this.probeAt = this.lastUpAt + this.wait;
    }
    return false;
  }
}
