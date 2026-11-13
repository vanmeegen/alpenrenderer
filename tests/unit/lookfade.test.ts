/**
 * The telescope's windows fade in when they first show: the terrain they
 * hold is finer and, at crests, tens of metres higher than the eye's level
 * drew it, and at 2.7° that is tens of pixels. A jump reads as a fault; a
 * third of a second of rising does not.
 */
import { describe, expect, test } from 'bun:test';
import { LOOK_FADE_MS, LOOK_FADE_STEP, LookFade } from '../../src/engine/core/lookfade';
import { Level } from '../../src/engine/core/heightfield';

const level = (o: Partial<Level> = {}): Level => ({
  z: 14, px0: 1000, py0: 2000, w: 640, h: 640, quant: 0.25, bias: -1000, role: 'look',
  raw: new Uint16Array(0), res: 6.5, maxRange: 0, cx: 0, cy: 0, version: 1, filled: true, ...o,
} as Level);

/** Frames of a twentieth of the fade from `from` to `to`, milliseconds; whether the last one left something rising. */
const FRAME = LOOK_FADE_MS / 20;
function run(f: LookFade, levels: Level[], from: number, to: number): boolean {
  let rising = false;
  for (let t = from + FRAME; t <= to + 1e-6; t += FRAME) rising = f.step(levels, t);
  return rising;
}

describe('LookFade', () => {
  test('a window that shows for the first time rises from nothing to full over the fade, smoothly, and then rests', () => {
    const f = new LookFade(), l = level();
    expect(f.step([l], 1000)).toBe(true);
    expect(l.weight).toBe(0);
    expect(run(f, [l], 1000, 1000 + LOOK_FADE_MS / 4)).toBe(true);
    expect(l.weight!).toBeGreaterThan(0.1);
    expect(l.weight!).toBeLessThan(0.25);                  // eased: slow at first
    expect(run(f, [l], 1000 + LOOK_FADE_MS / 4, 1000 + LOOK_FADE_MS / 2)).toBe(true);
    expect(l.weight).toBeCloseTo(0.5, 6);                  // smoothstep's middle
    expect(run(f, [l], 1000 + LOOK_FADE_MS / 2, 1000 + LOOK_FADE_MS)).toBe(false);
    expect(l.weight).toBe(1);
    expect(f.step([l], 99999)).toBe(false);
    expect(l.weight).toBe(1);
    expect(LOOK_FADE_MS).toBeGreaterThanOrEqual(200);
    expect(LOOK_FADE_MS).toBeLessThanOrEqual(600);
  });

  test('a hitch does not swallow the rise: however long a frame took, the window comes up by a quarter at most', () => {
    // A window's arrival is itself a hitch (its tiles are packed and sent to
    // the GPU), and a slow phone draws a frame in 150 ms: by the clock alone
    // the window would be half up, or all up, in the first frame after.
    const f = new LookFade(), l = level();
    f.step([l], 0);
    expect(f.step([l], 5000)).toBe(true);
    expect(LOOK_FADE_STEP).toBeCloseTo(0.25, 6);
    expect(l.weight).toBeCloseTo(0.15625, 6);              // smoothstep of a quarter
    let frames = 1;
    while (f.step([l], 5000 + frames * 5000)) frames++;
    expect(frames).toBe(3);                                // three in between, the fourth is all the way up
    expect(l.weight).toBe(1);
  });

  test('a window that follows the view a little keeps its weight: what was fine stays fine, nothing dips and rises again', () => {
    const f = new LookFade(), l = level();
    f.step([l], 0);
    run(f, [l], 0, LOOK_FADE_MS);
    l.px0 += 200; l.version++;                             // recentred, the old middle still well inside
    expect(f.step([l], LOOK_FADE_MS + 16)).toBe(false);
    expect(l.weight).toBe(1);
  });

  test('a window cut around a place the old one did not hold fades in anew', () => {
    const f = new LookFade(), l = level();
    f.step([l], 0);
    run(f, [l], 0, LOOK_FADE_MS);
    l.px0 += 3000; l.version++;
    expect(f.step([l], 5000)).toBe(true);
    expect(l.weight).toBe(0);
    expect(run(f, [l], 5000, 5000 + LOOK_FADE_MS)).toBe(false);
    expect(l.weight).toBe(1);
  });

  test('a window that was put down and shows again fades in again; eye levels and empty windows are left alone', () => {
    const f = new LookFade(), l = level(), eye = level({ role: undefined, maxRange: 4000 });
    f.step([l, eye], 0);
    run(f, [l, eye], 0, LOOK_FADE_MS);
    expect(eye.weight).toBeUndefined();
    l.filled = false;
    expect(f.step([l, eye], 2000)).toBe(false);
    l.filled = true; l.version++;
    expect(f.step([l, eye], 3000)).toBe(true);
    expect(l.weight).toBe(0);
  });

  test('with no time to fade (the tests\' switch) a window shows at once and nothing is left to draw', () => {
    const f = new LookFade(0), l = level();
    expect(f.step([l], 1000)).toBe(false);
    expect(l.weight).toBe(1);
  });

  test('each window fades on its own clock', () => {
    const f = new LookFade(), coarse = level({ z: 12 }), fine = level({ z: 14, filled: false });
    f.step([fine, coarse], 0);
    run(f, [fine, coarse], 0, LOOK_FADE_MS / 2 - FRAME);
    fine.filled = true;
    f.step([fine, coarse], LOOK_FADE_MS / 2);
    expect(coarse.weight).toBeCloseTo(0.5, 6);
    expect(fine.weight).toBe(0);
    expect(run(f, [fine, coarse], LOOK_FADE_MS / 2, LOOK_FADE_MS)).toBe(true);
    expect(coarse.weight).toBe(1);
    expect(fine.weight).toBeCloseTo(0.5, 6);
  });
});
