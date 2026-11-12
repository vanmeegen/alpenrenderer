/**
 * The ink line and the haze rim of the composite pass, on the CPU: the same
 * operators the shaders run on the packed log-range buffer (outline.ts is
 * injected into both dialects), fed with analytic fields. Screen y grows
 * downward; a field returns the log of the ground range at a pixel, or
 * OUTLINE.logSky where nothing is drawn.
 */
import { describe, expect, test } from 'bun:test';
import { LogField, OUTLINE, edgeAt, lineWidth, rimAt } from '../../src/engine/render/outline';

/** A near surface below row `edge`, a far one above it. */
const step = (near: number, far: number, edge = 100): LogField => (_x, y) => Math.log(y >= edge ? near : far);
/** Level ground seen from 1.7 m: the horizon at row 100, 0.1° of depression per pixel below it, sky above. */
const plane: LogField = (_x, y) => {
  const theta = ((y - 100) * 0.1 * Math.PI) / 180;
  return theta <= 0 ? OUTLINE.logSky : Math.log(1.7 / Math.tan(theta));
};

describe('the ink line', () => {
  test('a ridge 10 % behind another gets a full line, on the near ridge only, one pixel wide far away', () => {
    const L = step(20000, 22000);
    expect(edgeAt(L, 50.5, 100.5)).toBeGreaterThanOrEqual(0.9);   // the near surface, right under the edge
    expect(edgeAt(L, 50.5, 99.5)).toBe(0);                        // the far surface: no second line
    expect(edgeAt(L, 50.5, 98.5)).toBe(0);
    expect(edgeAt(L, 50.5, 102.5)).toBe(0);                       // two pixels in: the line has ended
  });

  test('close by the line is two to three pixels wide', () => {
    const L = step(500, 550);
    expect(lineWidth(Math.log(500))).toBeCloseTo(OUTLINE.widthNear, 6);
    expect(lineWidth(Math.log(30000))).toBeCloseTo(OUTLINE.widthFar, 6);
    expect(edgeAt(L, 50.5, 100.5)).toBeGreaterThanOrEqual(0.9);
    expect(edgeAt(L, 50.5, 101.5)).toBeGreaterThanOrEqual(0.9);
    expect(edgeAt(L, 50.5, 103.5)).toBe(0);
    expect(edgeAt(L, 50.5, 99.5)).toBe(0);
  });

  test('a 2 % jump is no line; grazing ground is no line, however flat the look at it', () => {
    expect(edgeAt(step(20000, 20400), 50.5, 100.5)).toBeLessThanOrEqual(0.1);
    // 1°, 2° and 5° of depression: the range grows 10 %, 5 % and 2 % per pixel going up, on an even surface.
    for (const row of [110.5, 120.5, 150.5]) expect(edgeAt(plane, 50.5, row)).toBe(0);
  });

  test('the skyline is always a line, and the sky itself never', () => {
    const L: LogField = (_x, y) => (y >= 100 ? Math.log(150000) : OUTLINE.logSky);
    expect(edgeAt(L, 50.5, 100.5)).toBe(1);
    expect(edgeAt(L, 50.5, 99.5)).toBe(0);
  });

  test('device pixels: at twice the scale the line reaches twice as far, fading out at its inner edge', () => {
    const L = step(20000, 22000);
    expect(edgeAt(L, 50.5, 101.5, 1)).toBe(0);
    expect(edgeAt(L, 50.5, 100.5, 2)).toBeGreaterThanOrEqual(0.9);
    expect(edgeAt(L, 50.5, 101.5, 2)).toBeGreaterThanOrEqual(0.5);   // one axis of the ring still crosses: the soft inner edge
    expect(edgeAt(L, 50.5, 103.5, 2)).toBe(0);
  });
});

describe('the haze rim', () => {
  test('the face right behind a nearer ridge is lightened; the near ridge and the face further up are not', () => {
    const L = step(8000, 12000);
    // Three pixels above the crest three of the eight taps land on the near ridge; four would be the full rim.
    expect(rimAt(L, 50.5, 97.5)).toBeCloseTo(OUTLINE.rim * 0.75, 6);
    expect(rimAt(L, 50.5, 100.5)).toBe(0);                        // the near ridge itself
    expect(rimAt(L, 50.5, 70.5)).toBe(0);                         // thirty pixels up: out of the rim
  });

  test('the rim fades away from the ridge and ends at its radius: a soft edge, not a band', () => {
    const L = step(8000, 12000);
    const close = rimAt(L, 50.5, 97.5), further = rimAt(L, 50.5, 100 - OUTLINE.rimRadius + 0.5);
    expect(further).toBeGreaterThan(0);
    expect(further).toBeLessThan(close * 0.5);
    expect(rimAt(L, 50.5, 100 - OUTLINE.rimRadius - 0.5)).toBe(0);
  });

  test('a meadow edge 100 m away glares no more than a ridge 4 km in front: each tap counts once, however large the jump', () => {
    expect(rimAt(step(100, 12000), 50.5, 97.5)).toBeCloseTo(rimAt(step(8000, 12000), 50.5, 97.5), 6);
    // And a ridge only 10 % in front leaves a fraction of it: the ink line does that job.
    expect(rimAt(step(20000, 22000), 50.5, 97.5)).toBeLessThan(OUTLINE.rim * 0.25);
    expect(rimAt(step(20000, 22000), 50.5, 97.5)).toBeGreaterThan(0);
  });

  test('an even surface has no rim, grazing or not', () => {
    for (const row of [110.5, 120.5, 150.5, 300.5]) expect(rimAt(plane, 50.5, row)).toBe(0);
  });

  test('the sky right above a skyline gets the rim too, weaker', () => {
    const L: LogField = (_x, y) => (y >= 100 ? Math.log(3000) : OUTLINE.logSky);
    const sky = rimAt(L, 50.5, 97.5);
    expect(sky).toBeCloseTo(OUTLINE.rim * OUTLINE.rimSky * 0.75, 6);
    expect(sky).toBeLessThan(0.12);                                // a glow, not a halo
  });
});
