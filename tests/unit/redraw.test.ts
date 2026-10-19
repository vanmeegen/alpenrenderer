/**
 * When a frame is worth drawing. The render loop ticks every animation
 * frame, but a view that nobody moved, with no level landing and no video
 * behind it, looks the same as the last frame: drawing it again only burns
 * the battery (and, under SwiftShader, a whole core per page). The gate
 * draws when any input changed, for the first frames (pipelines compile,
 * the atlas lands), on request, and always behind a live source.
 */
import { describe, expect, test } from 'bun:test';
import { FrameInputs, RedrawGate, frameFingerprint } from '../../src/engine/render/redraw';

function inputs(over: Partial<FrameInputs> = {}): FrameInputs {
  return {
    camera: { yaw: 90, pitch: 0, roll: 0, fov: 60 },
    size: { w: 1000, h: 600, scale: 1 },
    eye: 1501.7,
    origin: [10, 47],
    levels: [
      { version: 3, waterVersion: 1, filled: true, px0: 100, py0: 200 },
      { version: 2, waterVersion: 0, filled: false, px0: 0, py0: 0 },
    ],
    knobs: { shaded: true, outline: 0.7, band: null, horizonColor: [0.7, 0.8, 0.9] },
    ...over,
  };
}

describe('frameFingerprint', () => {
  test('is the same for the same inputs and differs for any changed one', () => {
    const base = frameFingerprint(inputs());
    expect(frameFingerprint(inputs())).toBe(base);
    const changed: Partial<FrameInputs>[] = [
      { camera: { yaw: 90.01, pitch: 0, roll: 0, fov: 60 } },
      { camera: { yaw: 90, pitch: 0, roll: 1, fov: 60 } },
      { size: { w: 1000, h: 601, scale: 1 } },
      { size: { w: 1000, h: 600, scale: 2 } },
      { eye: 1502 },
      { origin: [10, 47.0001] },
      { levels: [{ version: 4, waterVersion: 1, filled: true, px0: 100, py0: 200 }, { version: 2, waterVersion: 0, filled: false, px0: 0, py0: 0 }] },
      { levels: [{ version: 3, waterVersion: 2, filled: true, px0: 100, py0: 200 }, { version: 2, waterVersion: 0, filled: false, px0: 0, py0: 0 }] },
      { levels: [{ version: 3, waterVersion: 1, filled: true, px0: 100, py0: 200 }, { version: 2, waterVersion: 0, filled: true, px0: 0, py0: 0 }] },
      { levels: [{ version: 3, waterVersion: 1, filled: true, px0: 101, py0: 200 }, { version: 2, waterVersion: 0, filled: false, px0: 0, py0: 0 }] },
      { knobs: { shaded: false, outline: 0.7, band: null, horizonColor: [0.7, 0.8, 0.9] } },
      { knobs: { shaded: true, outline: 0.5, band: null, horizonColor: [0.7, 0.8, 0.9] } },
      { knobs: { shaded: true, outline: 0.7, band: [4000, 7812.5], horizonColor: [0.7, 0.8, 0.9] } },
      { knobs: { shaded: true, outline: 0.7, band: null, horizonColor: [0.7, 0.8, 0.91] } },
    ];
    for (const c of changed) expect(frameFingerprint(inputs(c))).not.toBe(base);
  });
});

describe('RedrawGate', () => {
  test('the first frames are drawn whatever the inputs: pipelines compile and the atlas lands over them', () => {
    const g = new RedrawGate(3);
    const f = frameFingerprint(inputs());
    expect([g.need(f, false), g.need(f, false), g.need(f, false)]).toEqual([true, true, true]);
    expect(g.need(f, false)).toBe(false);
  });

  test('an unchanged view draws nothing; a change draws exactly one frame', () => {
    const g = new RedrawGate(0);
    const f = frameFingerprint(inputs());
    expect(g.need(f, false)).toBe(true);     // the first ever
    expect(g.need(f, false)).toBe(false);
    expect(g.need(f, false)).toBe(false);
    const turned = frameFingerprint(inputs({ camera: { yaw: 91, pitch: 0, roll: 0, fov: 60 } }));
    expect(g.need(turned, false)).toBe(true);
    expect(g.need(turned, false)).toBe(false);
  });

  test('a live source behind the view (the camera image) draws every frame', () => {
    const g = new RedrawGate(0);
    const f = frameFingerprint(inputs());
    expect([g.need(f, true), g.need(f, true), g.need(f, true)]).toEqual([true, true, true]);
    expect(g.need(f, false)).toBe(false);
  });

  test('a request draws that many frames even without a change (context restored, a texture replaced)', () => {
    const g = new RedrawGate(0);
    const f = frameFingerprint(inputs());
    g.need(f, false);
    g.request(2);
    expect([g.need(f, false), g.need(f, false), g.need(f, false)]).toEqual([true, true, false]);
  });
});
