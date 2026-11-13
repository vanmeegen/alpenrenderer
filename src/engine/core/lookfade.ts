/**
 * The telescope's windows fade in.
 *
 * A look window (sources/clipmap.ts setLook) holds the ground looked at in
 * finer posts than the eye's level reaches it with, and finer posts keep
 * what coarser ones average away: a crest 15 km off stands twenty metres
 * higher in 6 m posts than in 51 m ones. At a view of 2.7° that is twenty
 * pixels, and a window that simply appears makes the ridge jump. So a
 * window rises: its weight (Level.weight) goes from 0 to 1 over LOOK_FADE_MS
 * once it shows, and the shaders and the mesh mirror lay it over the
 * coarser ground by that much. A frame moves it by LOOK_FADE_STEP of the
 * way at most: the frame a window arrives in is a slow one (its tiles are
 * packed and sent to the GPU), and by the clock alone the rise would be
 * half over before anything of it was drawn.
 *
 * A window that only follows the view (cut anew around a point the old
 * window still held) keeps its weight: what was fine stays fine. One cut
 * around other ground, or shown again after the telescope was put down,
 * starts over.
 */
import { Level } from './heightfield';

/** How long a window takes to rise into the picture, milliseconds. */
export const LOOK_FADE_MS = 350;
/** The most of the rise one frame takes, however long it took to draw. */
export const LOOK_FADE_STEP = 1 / 4;

interface Seen { at: number; progress: number; px0: number; py0: number }

export class LookFade {
  private seen = new Map<Level, Seen>();

  /** `ms`: how long a window takes to rise; 0 shows it at once. */
  constructor(private readonly ms = LOOK_FADE_MS) {}

  /**
   * Sets the weight of every filled look level for the time `now`
   * (milliseconds); true while any is still rising, so the caller keeps
   * drawing.
   */
  step(levels: readonly Level[], now: number): boolean {
    let rising = false;
    for (const l of levels) {
      if (l.role !== 'look') continue;
      if (!l.filled) { this.seen.delete(l); continue; }
      let s = this.seen.get(l);
      // Cut around a place whose middle the last cut did not hold: other ground.
      const moved = s && (Math.abs(l.px0 - s.px0) >= l.w / 2 || Math.abs(l.py0 - s.py0) >= l.h / 2);
      if (!s || moved) {
        s = { at: now, progress: this.ms > 0 ? 0 : 1, px0: l.px0, py0: l.py0 };
        this.seen.set(l, s);
      } else {
        if (s.progress < 1) s.progress = Math.min(1, s.progress + Math.min(Math.max(0, now - s.at) / this.ms, LOOK_FADE_STEP));
        if (s.progress > 1 - 1e-9) s.progress = 1;          // twenty twentieths are not quite one
        s.at = now;
        s.px0 = l.px0;
        s.py0 = l.py0;
      }
      const t = s.progress;
      l.weight = t * t * (3 - 2 * t);
      if (t < 1) rising = true;
    }
    return rising;
  }
}
