/**
 * Lakes as a water mask on the clipmap grid: one byte per DEM post, 255
 * where the post's centre lies inside a lake, 0 elsewhere. The renderer
 * packs it into the atlas's spare channel and the shade pass paints water
 * there.
 */
import { describe, expect, test } from 'bun:test';
import { mercXToLon, mercYToLat } from '../../src/engine/core/geodesy';
import { Lake, rasterizeLakes } from '../../src/engine/core/water';

const Z = 14, PX0 = 1000, PY0 = 2000, W = 16, H = 12;
const level = { z: Z, px0: PX0, py0: PY0, w: W, h: H };

/** A ring given in level pixels, as lon/lat pairs. */
const ring = (pts: [number, number][]) =>
  pts.flatMap(([x, y]) => [mercXToLon(PX0 + x, Z), mercYToLat(PY0 + y, Z)]);

const lake = (id: string, rings: number[][]): Lake => ({ id, name: id, lon: 0, lat: 0, rings });

const wet = (m: Uint8Array) => {
  const out: string[] = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) row += m[y * W + x] ? '#' : '.';
    out.push(row);
  }
  return out;
};

describe('rasterizeLakes', () => {
  test('a lake covers exactly the posts whose centre lies inside it', () => {
    // Pixels 2..5 in x (centres 2.5..5.5 inside 2..6), rows 3..4.
    const m = rasterizeLakes(level, [lake('Rechtecksee', [ring([[2, 3], [6, 3], [6, 5], [2, 5]])])]);
    expect(m.length).toBe(W * H);
    const rows = wet(m);
    expect(rows[2]).toBe('................');
    expect(rows[3]).toBe('..####..........');
    expect(rows[4]).toBe('..####..........');
    expect(rows[5]).toBe('................');
    expect(m[3 * W + 2]).toBe(255);
  });

  test('an island (inner ring) stays dry', () => {
    const outer = ring([[1, 1], [11, 1], [11, 9], [1, 9]]);
    const island = ring([[4, 4], [7, 4], [7, 6], [4, 6]]);
    const rows = wet(rasterizeLakes(level, [lake('Inselsee', [outer, island])]));
    expect(rows[2]).toBe('.##########.....');
    expect(rows[4]).toBe('.###...####.....');
    expect(rows[5]).toBe('.###...####.....');
    expect(rows[6]).toBe('.##########.....');
  });

  test('a slanted shore: a triangle fills left of its diagonal x = 0.8 y', () => {
    // The diagonal is kept off the post centres, where rounding would decide.
    const rows = wet(rasterizeLakes(level, [lake('Dreieck', [ring([[0, 0], [8, 10], [0, 10]])])]));
    expect(rows[0]).toBe('................');   // x < 0.4
    expect(rows[1]).toBe('#...............');   // x < 1.2
    expect(rows[4]).toBe('####............');   // x < 3.6
    expect(rows[7]).toBe('######..........');   // x < 6.0
  });

  test('lakes outside the level, and a lake clipped by its edge, do not overrun it', () => {
    const far = ring([[100, 100], [110, 100], [110, 110]]);
    const edge = ring([[-5, -5], [3, -5], [3, 2], [-5, 2]]);
    const rows = wet(rasterizeLakes(level, [lake('Fern', [far]), lake('Rand', [edge])]));
    expect(rows[0]).toBe('###.............');
    expect(rows[1]).toBe('###.............');
    expect(rows[2]).toBe('................');
  });
});
