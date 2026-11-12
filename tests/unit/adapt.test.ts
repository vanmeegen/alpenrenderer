/**
 * The renderer's answer to slow frames: while the view moves it measures the
 * time between drawn frames and, when they are too far apart, draws fewer
 * pixels, then leaves out what is optional; when they are fast again it
 * tries one step back, with a wait that grows each time the try fails.
 */
import { describe, expect, test } from 'bun:test';
import { ADAPT, Adaptation } from '../../src/engine/render/adapt';

/** Feeds `n` frames `dt` ms apart, starting at `t`; returns the time after them. */
function run(a: Adaptation, n: number, dt: number, t: number): number {
  for (let i = 0; i < n; i++) { t += dt; a.frame(dt, t); }
  return t;
}

describe('Adaptation', () => {
  test('frames inside the budget change nothing', () => {
    const a = new Adaptation();
    run(a, 400, 16, 0);
    expect(a.scale).toBe(1);
    expect(a.rim).toBe(true);
    run(a, 400, ADAPT.budgetMs, 10000);                         // right at the budget: still fine
    expect(a.scale).toBe(1);
  });

  test('a run of slow frames draws fewer pixels, a step per window, and at the last step leaves out the haze rim', () => {
    const a = new Adaptation();
    let t = run(a, ADAPT.window, 60, 0);
    expect(a.scale).toBe(ADAPT.steps[1]);
    t = run(a, ADAPT.window - 1, 60, t);
    expect(a.scale).toBe(ADAPT.steps[1]);                       // a whole window before the next step
    t = run(a, 1, 60, t);
    expect(a.scale).toBe(ADAPT.steps[2]);
    t = run(a, ADAPT.window, 60, t);
    expect(a.scale).toBe(ADAPT.steps[3]);
    expect(a.rim).toBe(true);
    t = run(a, ADAPT.window, 60, t);
    expect(a.scale).toBe(ADAPT.steps[3]);                       // no further down
    expect(a.rim).toBe(false);
    run(a, 10 * ADAPT.window, 60, t);
    expect(a.scale).toBe(2);
  });

  test('one slow frame among fast ones is not a slow run; the median decides', () => {
    const a = new Adaptation();
    let t = 0;
    for (let i = 0; i < 200; i++) { const dt = i % 7 === 0 ? 120 : 16; t += dt; a.frame(dt, t); }
    expect(a.scale).toBe(1);
  });

  test('a pause in the motion is not a frame time: the measuring starts over', () => {
    const a = new Adaptation();
    let t = run(a, ADAPT.window - 2, 60, 0);
    t += 2000;
    a.frame(2000, t);                                           // the view rested for two seconds
    run(a, 2, 60, t);
    expect(a.scale).toBe(1);
  });

  test('fast again, it tries one step back after a wait; a try that fails doubles the wait', () => {
    const a = new Adaptation();
    let t = run(a, 2 * ADAPT.window, 60, 0);
    expect(a.scale).toBe(ADAPT.steps[2]);
    // Fast frames, but the wait is not over: nothing yet.
    t = run(a, ADAPT.window, 10, t);
    expect(a.scale).toBe(ADAPT.steps[2]);
    t = run(a, Math.ceil(ADAPT.probeMs / 10) + ADAPT.window, 10, t);
    expect(a.scale).toBe(ADAPT.steps[1]);                       // one step back, on trial
    // The trial fails: slow again at once. Back down, and the next wait is twice as long.
    t = run(a, ADAPT.window, 60, t);
    expect(a.scale).toBe(ADAPT.steps[2]);
    t = run(a, Math.ceil(ADAPT.probeMs / 10) + ADAPT.window, 10, t);
    expect(a.scale).toBe(ADAPT.steps[2]);                       // the first wait is not enough any more
    t = run(a, Math.ceil(ADAPT.probeMs / 10) + ADAPT.window, 10, t);
    expect(a.scale).toBe(ADAPT.steps[1]);
    // This time it holds: the wait goes back to the short one.
    t = run(a, Math.ceil(ADAPT.probeMs / 10) + 2 * ADAPT.window, 10, t);
    expect(a.scale).toBe(1);
  });

  test('switched off (an explicit ?q=), nothing ever changes', () => {
    const a = new Adaptation(false);
    run(a, 20 * ADAPT.window, 200, 0);
    expect(a.scale).toBe(1);
    expect(a.rim).toBe(true);
  });
});
