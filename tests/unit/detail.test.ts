/**
 * The grain of the ground at your feet: a small tiling noise texture the
 * shade pass lays over the near range, fixed to the ground.
 */
import { describe, expect, test } from 'bun:test';
import { DETAIL, detailAt, detailFade, detailFrame, detailTexture, lit } from '../../src/engine/render/detail';

const N = DETAIL.size;
const tex = detailTexture();
const at = (x: number, y: number, c: number) => tex[(((y % N) + N) % N * N + ((x % N) + N) % N) * 4 + c];

describe('detailTexture', () => {
  test('is the same every time, and of the size the shaders are told', () => {
    expect(tex.length).toBe(N * N * 4);
    expect(Array.from(detailTexture())).toEqual(Array.from(tex));
  });

  test('its value averages to neutral and uses the range: grain, not a tint', () => {
    let sum = 0, min = 255, max = 0;
    for (let i = 0; i < N * N; i++) { const v = tex[i * 4 + 2]; sum += v; min = Math.min(min, v); max = Math.max(max, v); }
    expect(Math.abs(sum / (N * N) - 127.5)).toBeLessThan(1.5);
    expect(min).toBeLessThan(40);
    expect(max).toBeGreaterThan(215);
  });

  test('tiles: across the seam it changes no more than anywhere inside', () => {
    let inside = 0, seam = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N - 1; x++) inside = Math.max(inside, Math.abs(at(x + 1, y, 2) - at(x, y, 2)), Math.abs(at(y, x + 1, 2) - at(y, x, 2)));
      seam = Math.max(seam, Math.abs(at(0, y, 2) - at(N - 1, y, 2)), Math.abs(at(y, 0, 2) - at(y, N - 1, 2)));
    }
    expect(seam).toBeLessThanOrEqual(inside);
  });

  test('carries its own slope in the other two channels: where the value rises to the east, the first is above neutral', () => {
    let agree = 0, count = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = at(x + 1, y, 2) - at(x - 1, y, 2), dy = at(x, y + 1, 2) - at(x, y - 1, 2);
      if (Math.abs(dx) > 6) { count++; if (Math.sign(dx) === Math.sign(at(x, y, 0) - 127.5)) agree++; }
      if (Math.abs(dy) > 6) { count++; if (Math.sign(dy) === Math.sign(at(x, y, 1) - 127.5)) agree++; }
    }
    expect(count).toBeGreaterThan(500);
    expect(agree / count).toBeGreaterThan(0.98);
  });
});

describe('where the grain lies', () => {
  const M_PER_DEG = 111195;   // on the sphere the frame uses

  test('it is fixed to the ground: the same spot has the same grain from two standpoints', () => {
    // A spot 40 m east and 25 m north of the first standpoint, looked at
    // again from 60 m further west and 24 m further south. (Metres are
    // turned into offsets at each standpoint's own latitude; over this
    // distance that is millimetres, against a finest texel of 7 cm.)
    const lat = 47.3, lon = 11.2;
    const a = detailFrame(lon, lat);
    const dLon = 60 / (M_PER_DEG * Math.cos(lat * Math.PI / 180)), dLat = 24 / M_PER_DEG;
    const b = detailFrame(lon - dLon, lat - dLat);
    const here = detailAt(a, 40, 25), there = detailAt(b, 100, 49);
    for (let i = 0; i < 3; i++) expect(Math.abs(here[i] - there[i])).toBeLessThan(0.02);
    // The finest grain repeats `finer` times within the fine tile: a whole number, or it would not tile.
    expect(Number.isInteger(DETAIL.finer)).toBe(true);
    expect(DETAIL.fine / DETAIL.finer).toBeLessThan(6);
    const step = DETAIL.fine / DETAIL.finer / 2;
    const close = [0, 1, 2, 3, 4, 5].map((k) => detailAt(a, 40 + k * step, 25)[2]);
    expect(Math.max(...close) - Math.min(...close)).toBeGreaterThan(0.1);
    // And it is grain: a few metres on it is different.
    const spots = [0, 3, 6, 9, 12, 15].map((e) => detailAt(a, 40 + e, 25)[2]);
    expect(Math.max(...spots) - Math.min(...spots)).toBeGreaterThan(0.15);
  });

  test('the frame holds the standpoint as a fraction of a tile and the tiles per radian, fine and coarse', () => {
    const f = detailFrame(11.2, 47.3);
    for (const o of f.origin) { expect(o).toBeGreaterThanOrEqual(0); expect(o).toBeLessThan(1); }
    // One tile of the fine grain is DETAIL.fine metres of ground, to the 1 % a degree of latitude makes.
    const tileMetres = (6371008.8 * Math.cos(47.3 * Math.PI / 180)) / f.scale[0];
    expect(Math.abs(tileMetres / DETAIL.fine - 1)).toBeLessThan(0.015);
    expect(f.scale[0] / f.scale[1]).toBeCloseTo(DETAIL.coarse / DETAIL.fine, 6);
  });

  test('it is for the near range: full at your feet, gone before the ranges the colour tests probe', () => {
    expect(detailFade(10)).toBe(1);
    expect(detailFade(DETAIL.near)).toBe(1);
    expect(detailFade((DETAIL.near + DETAIL.far) / 2)).toBeGreaterThan(0.2);
    expect(detailFade(DETAIL.far)).toBe(0);
    expect(DETAIL.far).toBeLessThanOrEqual(2500);
  });
});

describe('what the grain does to the light', () => {
  const up: [number, number, number] = [0, 0, 1];

  test('neutral grain or none leaves the normal and the brightness alone', () => {
    for (const [d, fade] of [[[0, 0, 0], 1], [[0.8, -0.5, 0.6], 0]] as [[number, number, number], number][]) {
      const r = lit(up, d, fade);
      expect(r.grain).toBe(1);
      for (let i = 0; i < 3; i++) expect(r.normal[i]).toBeCloseTo(up[i], 9);
    }
  });

  test('a bump tilts the normal away from its rise and a high spot is brighter, by the constants', () => {
    const r = lit(up, [1, 0, 1], 1);
    expect(r.normal[0]).toBeLessThan(0);                     // rising to the east: the normal leans west
    expect(Math.hypot(...r.normal)).toBeCloseTo(1, 9);
    expect(r.normal[0] / r.normal[2]).toBeCloseTo(-DETAIL.tilt, 9);
    expect(r.grain).toBeCloseTo(1 + DETAIL.grain, 9);
    expect(lit(up, [1, 0, 1], 0.5).grain).toBeCloseTo(1 + DETAIL.grain / 2, 9);
  });
});
