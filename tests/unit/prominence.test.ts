/**
 * Topographic prominence from a height grid (tools/prominence.mjs, used by
 * tools/build_prominence.mjs to enrich the summit catalogue). Prominence is
 * the drop from a summit to the highest saddle (key col) that leads to
 * higher ground; the highest point of the grid has none and counts its
 * height. Cells are visited from the top down with a union-find, so the
 * first time a summit's region touches a higher one is at its key col.
 */
import { describe, expect, test } from 'bun:test';
// @ts-expect-error plain ES module without types, run by node at build time
import { burn, prominence, summitProminence } from '../../tools/prominence.mjs';

/** A w×h grid of whole metres from a function of (x, y). */
function grid(w: number, h: number, f: (x: number, y: number) => number): Int16Array {
  const g = new Int16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x, y);
  return g;
}

describe('prominence', () => {
  test('two cones on a plain: the higher one counts its height, the lower one its drop to the saddle between them', () => {
    // Plain at 1000 m. Cone A to 3000 m at (10, 15), cone B to 2500 m at
    // (40, 15), both 100 m per cell; between them the saddle lies where the
    // two slopes meet. Nothing else rises above the plain.
    const w = 50, h = 30;
    const g = grid(w, h, (x, y) => Math.max(1000, 3000 - 100 * Math.hypot(x - 10, y - 15), 2500 - 100 * Math.hypot(x - 40, y - 15)));
    const p = prominence(g, w, h);
    expect(p[15 * w + 10]).toBe(3000);
    // The saddle: on the line between the cones, where 3000 - 100·d = 2500 - 100·(30 - d) → d = 17.5; the grid holds 17 or 18.
    const saddle = Math.max(g[15 * w + 27], g[15 * w + 28]);
    expect(saddle).toBeGreaterThan(1200);
    expect(p[15 * w + 40]).toBe(2500 - saddle);
    // A cell on a slope is no summit and has no prominence.
    expect(Number.isNaN(p[15 * w + 20])).toBe(true);
  });

  test('a knoll on the flank of a bigger mountain gets only its own little rise', () => {
    const w = 40, h = 20;
    // A slope rising 5 m per cell to the east, with a 30 m knoll at (10, 10) that fades out over three cells.
    const g = grid(w, h, (x, y) => Math.round(1000 + 5 * x + Math.max(0, 30 - 10 * Math.hypot(x - 10, y - 10))));
    const p = prominence(g, w, h);
    // The knoll's top is 1080 m. Every way to the higher ground east crosses
    // the ring three cells out, where the knoll has faded: 1065 m at x = 13.
    expect(g[10 * w + 10]).toBe(1080);
    expect(p[10 * w + 10]).toBe(15);
    // The grid's highest cell counts its height.
    expect(p[g.indexOf(Math.max(...g))]).toBe(Math.max(...g));
  });

  test('a flat-topped summit is one summit: its prominence sits on one of its cells, the others carry nothing', () => {
    const w = 30, h = 30;
    const g = grid(w, h, (x, y) => (Math.hypot(x - 15, y - 15) <= 2 ? 2000 : Math.max(1000, 2000 - 100 * Math.hypot(x - 15, y - 15))));
    const p = prominence(g, w, h);
    const top = [] as number[];
    for (let i = 0; i < g.length; i++) if (g[i] === 2000 && !Number.isNaN(p[i])) top.push(p[i]);
    expect(top).toEqual([2000]);
  });

  test('summitProminence: a catalogue point takes the highest cell within reach, and that cell\'s prominence', () => {
    const w = 50, h = 30;
    const g = grid(w, h, (x, y) => Math.max(1000, 3000 - 100 * Math.hypot(x - 10, y - 15), 2500 - 100 * Math.hypot(x - 40, y - 15)));
    const p = prominence(g, w, h);
    // A point one cell off cone B's top, searched within 1.5 cells.
    expect(summitProminence(g, p, w, h, 41, 16, 1.5)).toBe(p[15 * w + 40]);
    // A point on the plain far from any summit: nothing within reach, undefined.
    expect(summitProminence(g, p, w, h, 25, 3, 1.5)).toBeUndefined();
  });

  test('the catalogue\'s elevation, burned into its cell, decides which of two neighbours owns the massif', () => {
    // A 212 m grid rounds a sharp summit off more than a broad one: the Rofan's
    // Hochiss (2299 m) read 2185 in its cell, the broader Rofanspitze (2259 m)
    // 2200, and the grid handed the massif's 1250 m of prominence to the
    // wrong one. With the surveyed heights burned into their cells the order
    // is right again, and each takes its drop to their common col.
    const w = 40, h = 20;
    const g = grid(w, h, (x, y) => Math.max(1000, 2185 - 60 * Math.hypot(x - 10, y - 10), 2200 - 60 * Math.hypot(x - 30, y - 10)));
    const before = prominence(g, w, h);
    expect(before[10 * w + 30]).toBe(2200);                 // the grid's highest cell: the broad one
    // The col is the lowest cell on the ridge between them, where the two slopes meet.
    const col = g[10 * w + 20];
    expect(col).toBeLessThan(Math.min(g[10 * w + 19], g[10 * w + 21]));
    expect(before[10 * w + 10]).toBe(2185 - col);
    const burnt = burn(g, w, h, [[10, 10, 2299], [30, 10, 2259]]);
    const after = prominence(burnt, w, h);
    expect(after[10 * w + 10]).toBe(2299);
    expect(after[10 * w + 30]).toBe(2259 - col);
    // A catalogue height below the cell's own leaves the cell alone.
    expect(burn(g, w, h, [[10, 10, 1500]])[10 * w + 10]).toBe(2185);
  });
});
