/**
 * The surface of a clipmap level as the shade pass reads it: a normal and
 * an occlusion value per post, worked out once on the CPU. Heights here are
 * functions of the post index; a post is `MPP` metres.
 */
import { describe, expect, test } from 'bun:test';
import { levelSurface, surfaceAt } from '../../src/engine/core/surface';

const W = 96, H = 96, MPP = 13, QUANT = 0.25;
const DEG = Math.PI / 180;

/** A level from a height function of metres east and north of its centre. */
function level(f: (east: number, north: number) => number) {
  const raw = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    raw[y * W + x] = Math.round((f((x - W / 2) * MPP, (H / 2 - y) * MPP) + 1000) / QUANT);
  }
  const out = new Uint8Array(W * H * 4);
  levelSurface(raw, W, H, QUANT, MPP, out);
  /** Normal (east, north, up) and occlusion at a post, as the shader decodes them. */
  return (x: number, y: number) => surfaceAt(out, W, x, y);
}
const angle = (a: number[], b: number[]) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) / DEG;
const unit = (v: number[]) => { const l = Math.hypot(...v); return v.map((c) => c / l); };

describe('levelSurface', () => {
  test('an even slope: the normal is the slope\'s own to half a degree, the occlusion neutral', () => {
    // Rising 0.5 m per metre to the east and 0.2 to the north.
    const at = level((e, n) => 2000 + 0.5 * e + 0.2 * n);
    const want = unit([-0.5, -0.2, 1]);
    for (const [x, y] of [[20, 20], [48, 48], [70, 30]]) {
      const s = at(x, y);
      expect(angle(s.normal, want)).toBeLessThan(0.5);
      expect(Math.abs(s.occlusion - 0.5)).toBeLessThan(0.02);
    }
  });

  test('on a cone the normals turn evenly round it: within a degree of the cone\'s own, post by post', () => {
    // 45°, the apex in the middle; looked at eight posts and more from it.
    const at = level((e, n) => 3000 - Math.hypot(e, n));
    let worst = 0;
    for (let y = 10; y < H - 10; y += 3) for (let x = 10; x < W - 10; x += 3) {
      const e = (x - W / 2) * MPP, n = (H / 2 - y) * MPP, r = Math.hypot(e, n);
      if (r < 8 * MPP) continue;
      worst = Math.max(worst, angle(at(x, y).normal, unit([e / r, n / r, 1])));
    }
    expect(worst).toBeLessThan(1);
  });

  test('a break between two faces stays a break: a post either side of it has its own face\'s normal', () => {
    // Level ground west of the middle, a 45° face rising east of it. A plain
    // smoothing rounds the foot of every wall; the sharpening takes that back.
    const at = level((e) => 2000 + Math.max(0, e));
    const flat = at(W / 2 - 3, 48), face = at(W / 2 + 3, 48);
    expect(angle(flat.normal, [0, 0, 1])).toBeLessThan(3);
    expect(angle(face.normal, unit([-1, 0, 1]))).toBeLessThan(3);
  });

  test('a gully is darker than the ridge beside it; the faces between them are neither', () => {
    // A sawtooth across the east: ridges and gullies 16 posts apart, 40 m of relief.
    const period = 16 * MPP;
    // Gullies at whole periods, ridges half a period on.
    const at = level((e) => 2000 + 40 * (1 - Math.abs(((e / period) % 1 + 1) % 1 - 0.5) * 2));
    const column = (east: number) => at(Math.round(W / 2 + east / MPP), 48).occlusion;
    const gully = column(0), ridge = column(period / 2), face = column(period / 4);
    expect(gully).toBeLessThan(0.35);
    expect(ridge).toBeGreaterThan(0.65);
    expect(Math.abs(face - 0.5)).toBeLessThan(0.08);
  });

  test('whole metres of noise on a gentle slope are not relief: the normal stays within three degrees', () => {
    // What a one-metre DEM does to a 4° meadow, held to quarter metres: ±0.5 m from post to post.
    const noise = (x: number, y: number) => (((x * 73 + y * 151) % 17) / 17 - 0.5);
    const at = level((e, n) => 2000 + 0.07 * e + noise(Math.round(e / MPP), Math.round(n / MPP)));
    const want = unit([-0.07, 0, 1]);
    let worst = 0;
    for (let y = 10; y < H - 10; y += 5) for (let x = 10; x < W - 10; x += 5) worst = Math.max(worst, angle(at(x, y).normal, want));
    expect(worst).toBeLessThan(3);
  });

  test('the bytes hold a unit normal in two channels and the occlusion in the third', () => {
    const at = level((e, n) => 2000 + 0.5 * e + 0.2 * n);
    const s = at(48, 48);
    expect(Math.hypot(...s.normal)).toBeCloseTo(1, 6);
    expect(s.normal[2]).toBeGreaterThan(0);
  });
});
