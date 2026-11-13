/**
 * What a zoomed frame shows: for every stretch of distance, whether ground
 * there stands in the frame and whether anything nearer hides it. The rings
 * of the mesh go where ground is seen (mesh.ts ringTable); before, they went
 * where the centre of the view pointed, and a mountain beside the centre
 * was drawn with rings hundreds of metres apart.
 */
import { describe, expect, test } from 'bun:test';
import { FrameBox, FrameScanner, FrameView, SCAN, frameScan, scanBin, scanBins, scanBox, scanStart } from '../../src/engine/render/framescan';
import { RIDGES, twoRidges } from './helpers/ridges';

// A frame 3.2° high a degree above the horizon, 5.3° wide, looking east, with a quarter more on every side.
const BOX = { az0: 86, az1: 94, el0: -1.4, el1: 3.4 };

describe('the bins of distance', () => {
  test('are fixed, a fortieth of the range wide, from the feet to the last level', () => {
    expect(scanStart(0)).toBe(SCAN.r0);
    expect(scanStart(1) / scanStart(0)).toBeCloseTo(SCAN.ratio, 9);
    for (const r of [2, 2.04, 150, 16000, 200000]) {
      const b = scanBin(r);
      expect(scanStart(b)).toBeLessThanOrEqual(r * (1 + 1e-12));
      expect(scanStart(b + 1)).toBeGreaterThan(r);
    }
    const n = scanBins(272000);
    expect(scanStart(n)).toBeGreaterThanOrEqual(272000);
    expect(scanStart(n - 1)).toBeLessThan(272000);
  });
});

describe('frameScan', () => {
  const { hf, eye } = twoRidges();
  const view = frameScan(hf, eye, BOX);
  const { classes, need } = view;
  const at = (r: number) => classes[scanBin(r)];
  const needIn = (from: number, to: number, n = need) => {
    let sum = 0;
    for (let b = scanBin(from); b <= scanBin(to); b++) sum += n[b];
    return sum;
  };

  test('the face of a ridge that rises into the frame is seen; its foot under the frame is not in it', () => {
    expect(classes.length).toBe(scanBins(hf.maxRange));
    expect(need.length).toBe(classes.length);
    // 300 m above the plain, the plain lies under the frame's lower edge (-1.4°) out to 12 km.
    expect(at(3000)).toBe(0);
    expect(at(9000)).toBe(0);
    // The near ridge's face, from where it comes into the frame up to its crest.
    expect(at(15500)).toBe(2);
    expect(at(RIDGES.near.at - 50)).toBe(2);
  });

  test('ground behind a crest is in the frame but hidden; a higher ridge behind shows its top', () => {
    // The near ridge's back and the dip behind it: within the frame's angles, under the crest's line.
    expect(at(17200)).toBe(1);
    expect(at(23800)).toBe(1);
    // The far ridge stands 300 m higher: its top looks over.
    expect(at(RIDGES.far.at - 50)).toBe(2);
    // Behind it nothing rises above it.
    expect(at(30000)).not.toBe(2);
  });

  test('what is seen reaches a bin further on both sides, so a crest between two samples is not left out', () => {
    const first = classes.indexOf(2);
    const firstSeen = frameScan(hf, eye, BOX, { dilate: 0 }).classes.indexOf(2);
    expect(first).toBe(firstSeen - 1);
  });

  test('need: how much of the frame\'s height comes into view in each stretch of distance', () => {
    // What a stretch of ground needs of the mesh is rows of the screen, not
    // metres: rings as far apart as a pixel or two of the picture, on the
    // ground that rises into view, leave a crest at most that much too low.
    // Measured as the tangent of the elevation angle the ray's skyline
    // climbs by there, the highest of all rays.
    const drop = (r: number) => (r * r) / (2 * 6371008.8 / (1 - 0.13));
    const lower = Math.tan((-1.4 * Math.PI) / 180);
    const nearCrest = (RIDGES.near.top - RIDGES.eye - drop(16000)) / 16000;
    const farCrest = (RIDGES.far.top - RIDGES.eye - drop(26000)) / 26000;
    // From the frame's lower edge up to the near crest: the plain as it comes in, then the face.
    const near = needIn(11000, 16500);
    expect(near).toBeGreaterThan((nearCrest - lower) * 0.95);
    expect(near).toBeLessThan((nearCrest - lower) * 2.1);    // a rise between two bins is counted for both
    // The far ridge shows only what stands over the near crest.
    const far = needIn(24000, 27000);
    expect(far).toBeGreaterThan((farCrest - nearCrest) * 0.9);
    expect(far).toBeLessThan((farCrest - nearCrest) * 2.1);
    // Hidden ground and ground out of the frame need nothing.
    expect(needIn(17500, 23500)).toBe(0);
    expect(needIn(2000, 9000)).toBe(0);
  });

  test('a plain seen from above needs the frame\'s height once, however far it reaches: not rings by the metre', () => {
    // Looking down on the plain from 300 m, from 12° to 2° under the horizon: 1.4 km to 8.6 km of ground.
    const down = frameScan(hf, eye, { ...BOX, el0: -12, el1: -2 });
    const height = Math.tan((-2 * Math.PI) / 180) - Math.tan((-12 * Math.PI) / 180);
    const total = needIn(1000, 9500, down.need);
    expect(total).toBeGreaterThan(height * 0.95);
    expect(total).toBeLessThan(height * 2.1);
    expect(Array.from(down.classes).filter((c) => c === 2).length).toBeGreaterThan(60);
  });

  test('a frame aimed at the sky above the ridges, or at the ground under them, shows none of this', () => {
    const sky = frameScan(hf, eye, { ...BOX, el0: 8, el1: 12 });
    expect(Array.from(sky.classes).every((c) => c === 0)).toBe(true);
    expect(Array.from(sky.need).every((n) => n === 0)).toBe(true);
    const down = frameScan(hf, eye, { ...BOX, el0: -12, el1: -8 });
    expect(down.classes[scanBin(15500)]).toBe(0);
    expect(down.classes[scanBin(1800)]).toBe(2);            // the plain 300 m below, 10° down: 1.7 km out
  });
});

describe('scanBox: what is scanned for a frame depends on the frame alone', () => {
  const frame = (yaw: number, pitch = 1, fov = 3.2) => ({ az0: yaw - 2.65, az1: yaw + 2.65, el0: pitch - fov / 2, el1: pitch + fov / 2 });
  const inside = (f: FrameBox, b: FrameBox) => f.az0 >= b.az0 && f.az1 <= b.az1 && f.el0 >= b.el0 && f.el1 <= b.el1;

  test('the box holds the frame, with room, and is the same for every frame of its cell of bearings, tilt and zoom', () => {
    // The scan used to be kept while the frame stayed near where it was made: the rings, and with
    // them the picture, depended on the way the view had come. After a reload a summit stood
    // 3 px elsewhere (CI, 2026-11-13). Now the box is cut on a fixed lattice.
    for (const [yaw, pitch, fov] of [[90, 1, 3.2], [137.31, -4.2, 2.7], [359.2, 12, 25], [0.4, 0, 8]]) {
      const f = frame(yaw, pitch, fov), b = scanBox(f);
      expect(inside(f, b)).toBe(true);
      expect(b.az1 - b.az0).toBeLessThan((f.az1 - f.az0) * 1.8);
      expect(b.el1 - b.el0).toBeLessThan((f.el1 - f.el0) * 1.8);
    }
    expect(scanBox(frame(90.2))).toEqual(scanBox(frame(90)));            // a little aside: the same cell
    expect(scanBox(frame(90, 1.1))).toEqual(scanBox(frame(90)));
    expect(scanBox(frame(90, 1, 3.1))).toEqual(scanBox(frame(90)));     // zoomed a little
    expect(scanBox(frame(92))).not.toEqual(scanBox(frame(90)));
    expect(scanBox(frame(90, 1, 1.6))).not.toEqual(scanBox(frame(90)));
  });
});

describe('FrameScanner', () => {
  const { hf, eye } = twoRidges();
  const frame = (yaw: number, pitch = 1, fov = 3.2) => ({ az0: yaw - 2.65, az1: yaw + 2.65, el0: pitch - fov / 2, el1: pitch + fov / 2 });

  test('the same frame gets the same scan whatever was looked at before', () => {
    const fresh = new FrameScanner(), used = new FrameScanner();
    const a = fresh.scan(hf, eye, frame(90), 'v1')!;
    for (const yaw of [96, 93.1, 91.3, 88.2]) used.scan(hf, eye, frame(yaw), 'v1');
    const b = used.scan(hf, eye, frame(90.2), 'v1')!;
    expect(Array.from(b.classes)).toEqual(Array.from(a.classes));
    expect(Array.from(b.need)).toEqual(Array.from(a.need));
  });

  test('a pan within the cell keeps the scan; another cell, a zoom, new terrain or another eye makes a new one; coming back, the old one is still there', () => {
    const s = new FrameScanner();
    const a = s.scan(hf, eye, frame(90), 'v1')!;
    expect(a.classes[scanBin(15500)]).toBe(2);
    expect(s.scan(hf, eye, frame(90.2), 'v1')).toBe(a);
    expect(s.scan(hf, eye, frame(90, 1.1), 'v1')).toBe(a);
    expect(s.scans).toBe(1);
    const b = s.scan(hf, eye, frame(93), 'v1');
    expect(b).not.toBe(a);
    expect(s.scans).toBe(2);
    // Back and forth over the edge of a cell costs nothing.
    expect(s.scan(hf, eye, frame(90), 'v1')).toBe(a);
    expect(s.scan(hf, eye, frame(93), 'v1')).toBe(b);
    expect(s.scans).toBe(2);
    expect(s.scan(hf, eye, frame(93, 1, 1.6), 'v1')).not.toBe(b);        // zoomed in to half
    const c = s.scan(hf, eye, frame(93, 1, 1.6), 'v1');
    expect(s.scan(hf, eye, frame(93, 1, 1.6), 'v2')).not.toBe(c);        // levels arrived
    expect(s.scan(hf, eye + 30, frame(93, 1, 1.6), 'v2')).not.toBe(c);   // the eye moved
  });

  test('with a budget a scan is spread over calls: the old one stands until the new is whole, and the result is the same as in one go', () => {
    // A scan is 24 000 height lookups, 10–20 ms on a desktop: in one frame of
    // a phone that is a stutter every time the pan enters another cell.
    const whole = new FrameScanner(), sliced = new FrameScanner();
    const a = whole.scan(hf, eye, frame(90), 'v1');
    // The first scan has nothing to stand in for it: null until it is done, a ray a call at least.
    let first: FrameView | null = null, calls = 0;
    while (!first && calls < 100) { first = sliced.scan(hf, eye, frame(90), 'v1', 0); calls++; }
    expect(calls).toBe(SCAN.rays);
    expect(Array.from(first!.classes)).toEqual(Array.from(a!.classes));
    expect(Array.from(first!.need)).toEqual(Array.from(a!.need));
    expect(sliced.scanning).toBe(false);
    // Panned into another cell: the old scan is handed out while the new one runs.
    const b = whole.scan(hf, eye, frame(93), 'v1');
    let next = sliced.scan(hf, eye, frame(93), 'v1', 0);
    expect(next).toBe(first);
    expect(sliced.scanning).toBe(true);
    calls = 1;
    while (next === first && calls < 100) { next = sliced.scan(hf, eye, frame(93), 'v1', 0); calls++; }
    expect(calls).toBe(SCAN.rays);
    expect(Array.from(next!.classes)).toEqual(Array.from(b!.classes));
    expect(sliced.scans).toBe(2);
  });
});
