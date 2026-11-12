/**
 * The clear view: how far the eye is lifted over what stands right around
 * the standpoint. Terrain here is a function of metres east and north of
 * the standpoint; `far` gives, per bearing, the tangent of the highest
 * apparent elevation of everything beyond the disc, as the horizon table
 * does in the app.
 */
import { describe, expect, test } from 'bun:test';
import { CLEAR_VIEW, clearView, fitRadius } from '../../src/engine/core/eye';

const R = 30, STEP = 3;
/** The far horizon of a terrain: the highest tangent beyond the disc, out to 20 km, from `eye`. */
const farOf = (height: (e: number, n: number) => number, eye: number) => (bearing: number) => {
  const b = (bearing * Math.PI) / 180;
  let best = -Infinity;
  for (let r = R; r < 20000; r *= 1.02) best = Math.max(best, (height(r * Math.sin(b), r * Math.cos(b)) - eye) / r);
  return best;
};
const lift = (height: (e: number, n: number) => number, ground = height(0, 0)) =>
  clearView(height, farOf(height, ground + 1.7), ground + 1.7, R, STEP).lift;

describe('clearView', () => {
  test('level ground and an even slope lift nothing: uphill there really is nothing to see', () => {
    expect(lift(() => 1500)).toBe(0);
    expect(lift((e, n) => 1500 + 0.6 * n - 0.2 * e)).toBe(0);            // 32°, rising to the north
  });

  test('an uneven mountain slope lifts little: the humps on it are the mountain, and it goes on above them', () => {
    // The Mauritzalm: a meadow at 20°, two to three metres of relief on it.
    // Fitting a plane to it and standing over its highest point put the eye
    // 6.5 m up; a ridge 400 m away then stood a degree off in the camera view.
    const meadow = (e: number, n: number) => 1840 + 0.36 * n + 2.5 * Math.sin(e / 9) * Math.cos(n / 7);
    expect(lift(meadow)).toBeLessThan(1.5);
  });

  test('a bank 3 m high and 14 m deep in front of level ground lifts the eye over it', () => {
    // Pertisau: the embankment of the lakeside road, 14 to 28 m from the
    // standpoint, nothing but the plain behind. At 1.7 m it was the whole view north.
    const bank = (_e: number, n: number) => (n >= 14 && n <= 28 ? 1503 : 1500);
    const l = lift(bank);
    expect(1.7 + l).toBeGreaterThan(3);                                    // over its top…
    expect(1.7 + l).toBeLessThan(3 + 2 * CLEAR_VIEW.margin);               // …and no more than that
  });

  test('with mountains behind the bank the eye rises only until they show over it', () => {
    // A ridge 3.5° up, 20 km out: a bank whose top stands lower than that from where the eye is hides none of it.
    const scene = (e: number, n: number) => {
      const r = Math.hypot(e, n);
      return n >= 14 && n <= 28 ? 1503 : r >= 19500 && r <= 20500 ? 1500 + 1225 : 1500;
    };
    const l = lift(scene);
    expect(l).toBeGreaterThan(0);
    expect(l).toBeLessThan(lift((_e, n) => (n >= 14 && n <= 28 ? 1503 : 1500)));
    // From the lifted eye the bank's far edge stands below the ridge.
    const eye = 1501.7 + l;
    expect((1503 - eye) / 28).toBeLessThan((2725 - eye) / 20000);
  });

  test('a terrace that goes on beyond the disc lifts less than a bank: its top is also the horizon behind it', () => {
    const terrace = (_e: number, n: number) => (n >= 20 ? 1503 : 1500);
    const l = lift(terrace);
    expect(l).toBeGreaterThan(0);
    expect(l).toBeLessThan(lift((_e, n) => (n >= 14 && n <= 28 ? 1503 : 1500)) - 0.5);
  });

  test('standing in a hollow, the eye comes up over its rim', () => {
    const hollow = (e: number, n: number) => (Math.hypot(e, n) < 6 ? 1497 : 1500);
    const l = lift(hollow);
    expect(1.7 + l - 3).toBeGreaterThan(0);                                // 3 m deep: the eye is above the ground around
    expect(1.7 + l - 3).toBeLessThan(2 * CLEAR_VIEW.margin);
  });

  test('at the foot of a wall the eye does not go up the wall: capped, and where nothing is known beyond the disc, nothing is lifted', () => {
    const tower = (e: number, n: number) => (Math.abs(e) < 6 && n >= 10 && n <= 20 ? 1560 : 1500);
    expect(lift(tower)).toBe(CLEAR_VIEW.cap);
    expect(clearView(tower, () => -Infinity, 1501.7, R, STEP).lift).toBe(0);
  });

  test('the radius is the fix accuracy, within 15 to 50 m; 30 m when the standpoint was chosen on the map', () => {
    expect(fitRadius(null)).toBe(30);
    expect(fitRadius(undefined)).toBe(30);
    expect(fitRadius(4)).toBe(15);
    expect(fitRadius(22)).toBe(22);
    expect(fitRadius(850)).toBe(50);
  });
});
