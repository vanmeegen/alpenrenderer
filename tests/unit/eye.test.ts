/**
 * The clear view: how far the eye is lifted over what stands right around
 * the standpoint. Terrain here is a function of metres east and north of
 * the standpoint.
 */
import { describe, expect, test } from 'bun:test';
import { CLEAR_VIEW, clearView, fitRadius } from '../../src/engine/core/eye';

const flat = () => 1500;

describe('clearView', () => {
  test('level ground and an even slope lift nothing: uphill there really is nothing to see', () => {
    expect(clearView(flat, 30, 3).lift).toBe(0);
    const slope = (e: number, n: number) => 1500 + 0.6 * n - 0.2 * e;       // 32°, rising to the north
    expect(clearView(slope, 30, 3).lift).toBe(0);
    expect(clearView(slope, 50, 5).lift).toBe(0);
  });

  test('a 3 m bank 20 m ahead on level ground lifts the eye over it', () => {
    // Pertisau: the DEM holds the lakeside road's embankment, 10 to 30 m
    // from the standpoint; at 1.7 m the whole view north was that bank.
    const bank = (_e: number, n: number) => (n >= 20 ? 1503 : 1500);
    const { lift } = clearView(bank, 30, 3);
    expect(1.7 + lift).toBeGreaterThan(3.5);                                // over the bank, with room
    expect(lift).toBeLessThan(4);                                           // not a tower
  });

  test('standing in a hollow, the eye comes up to where it would stand on the ground around it', () => {
    const hollow = (e: number, n: number) => (Math.hypot(e, n) < 6 ? 1498 : 1500);
    const { lift } = clearView(hollow, 30, 2);
    expect(lift).toBeGreaterThan(1.7);
    expect(lift).toBeLessThan(2.3);
  });

  test('standing on a knoll or on a ridge crest lifts nothing: the eye is already over everything near', () => {
    const knoll = (e: number, n: number) => 1500 + Math.max(0, 4 - 0.2 * Math.hypot(e, n));
    expect(clearView(knoll, 30, 3).lift).toBe(0);
    const crest = (e: number) => 1500 - 0.5 * Math.abs(e);
    expect(clearView(crest, 30, 3).lift).toBe(0);
  });

  test('roughness under the dead band is the DEM, not an obstacle; a cliff foot is capped', () => {
    // Whole metres on a gentle slope: steps of up to a metre that are not there.
    const stepped = (_e: number, n: number) => 1500 + Math.round(0.04 * n);
    expect(clearView(stepped, 30, 3).lift).toBe(0);
    const wall = (_e: number, n: number) => (n >= 10 ? 1560 : 1500);
    expect(clearView(wall, 30, 3).lift).toBe(CLEAR_VIEW.cap);
  });

  test('the radius is the fix accuracy, within 15 to 50 m; 30 m when the standpoint was chosen on the map', () => {
    expect(fitRadius(null)).toBe(30);
    expect(fitRadius(undefined)).toBe(30);
    expect(fitRadius(4)).toBe(15);
    expect(fitRadius(22)).toBe(22);
    expect(fitRadius(850)).toBe(50);
  });
});
