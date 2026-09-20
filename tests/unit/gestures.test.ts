/**
 * The gesture model is pure: pointer events in, camera changes out. The DOM
 * adapter (LookControls) only forwards events, so everything about how a
 * drag, a pinch, a flick or a wheel turns into yaw, pitch and fov is decided
 * — and tested — here.
 *
 * Pointer positions are recorded as they arrive and applied once per frame by
 * `tick()`. Two fingers report as two separate events; applying each on its
 * own would zoom with a spread that is only half updated and turn with the
 * wrong field of view in between. Per frame, both fingers have moved.
 */
import { describe, expect, test } from 'bun:test';
import { Camera } from '../../src/engine/core/camera';
import { GestureModel } from '../../src/app/gestures';

function setup(fov = 60, w = 1000, h = 500) {
  const cam = new Camera();
  cam.aspect = w / h;
  cam.set({ yaw: 90, pitch: 0, fov });
  cam.update();
  const g = new GestureModel(cam, () => ({ width: w, height: h }));
  return { cam, g };
}

describe('one finger: look around', () => {
  test('a drag of one screen width turns exactly one horizontal field of view, against the finger', () => {
    const { cam, g } = setup(60, 1000, 500);
    const hfov = cam.hfov;
    g.down(1, 100, 250, 0);
    g.move(1, 1100, 250, 16);
    g.tick(16);
    expect(cam.yaw).toBeCloseTo(((90 - hfov) + 360) % 360, 6);
  });

  test('nothing moves before the frame applies it', () => {
    const { cam, g } = setup();
    g.down(1, 100, 250, 0);
    g.move(1, 300, 250, 16);
    expect(cam.yaw).toBe(90);
  });

  test('dragging down looks up, one screen height is one vertical fov', () => {
    const { cam, g } = setup(60, 1000, 500);
    g.down(1, 500, 100, 0);
    g.move(1, 500, 350, 16);
    g.tick(16);
    expect(cam.pitch).toBeCloseTo(30, 6);
  });

  test('pitch is clamped by the camera', () => {
    const { cam, g } = setup(60, 1000, 500);
    g.down(1, 500, 0, 0);
    g.move(1, 500, 5000, 16);
    g.tick(16);
    expect(cam.pitch).toBe(89);
  });

  test('a flick keeps turning after release and decays to a stop', () => {
    const { cam, g } = setup(60, 1000, 500);
    g.down(1, 500, 250, 0);
    g.move(1, 520, 250, 10); g.tick(10);
    g.move(1, 540, 250, 20); g.tick(20);
    g.up(1, 25);
    const yawAtRelease = cam.yaw;
    g.tick(36);
    expect(cam.yaw).not.toBe(yawAtRelease);
    for (let i = 0; i < 400; i++) g.tick(40 + i * 16);
    const settled = cam.yaw;
    g.tick(7000);
    expect(cam.yaw).toBe(settled);
  });

  test('a slow release is not a flick', () => {
    const { cam, g } = setup(60, 1000, 500);
    g.down(1, 500, 250, 0);
    g.move(1, 540, 250, 10); g.tick(10);
    g.up(1, 500);                   // half a second later
    const yaw = cam.yaw;
    g.tick(516);
    expect(cam.yaw).toBe(yaw);
  });
});

describe('two fingers: pinch zoom', () => {
  test('spreading the fingers narrows the field of view in proportion', () => {
    const { cam, g } = setup(60, 1000, 500);
    g.down(1, 400, 250, 0);
    g.down(2, 600, 250, 0);         // 200 px apart
    g.move(1, 300, 250, 16);
    g.move(2, 700, 250, 16);        // 400 px apart: twice the spread
    g.tick(16);
    expect(cam.fov).toBeCloseTo(30, 6);
  });

  test('the midpoint still turns the view while pinching, scaled by the fov after the pinch', () => {
    const { cam, g } = setup(60, 1000, 500);
    g.down(1, 400, 250, 0);
    g.down(2, 600, 250, 0);
    g.move(1, 500, 250, 16);
    g.move(2, 700, 250, 16);        // same spread, midpoint +100 px
    g.tick(16);
    expect(cam.fov).toBeCloseTo(60, 6);
    expect(cam.yaw).toBeCloseTo(90 - cam.hfov * 0.1, 6);
  });

  test('fov stays within its limits', () => {
    const { cam, g } = setup(60, 1000, 500);
    g.down(1, 499, 250, 0);
    g.down(2, 501, 250, 0);
    g.move(1, 0, 250, 16);
    g.move(2, 1000, 250, 16);
    g.tick(16);
    expect(cam.fov).toBe(g.minFov);
    g.up(1, 20); g.up(2, 20);
    g.down(1, 0, 250, 30);
    g.down(2, 1000, 250, 30);
    g.move(1, 499, 250, 40);
    g.move(2, 501, 250, 40);
    g.tick(40);
    expect(cam.fov).toBe(g.maxFov);
  });

  test('a second finger landing does not jump the view', () => {
    const { cam, g } = setup(60, 1000, 500);
    g.down(1, 400, 250, 0);
    g.tick(0);
    g.down(2, 800, 250, 10);        // centroid jumps 200 px: must not turn
    g.tick(10);
    expect(cam.yaw).toBe(90);
  });

  test('lifting one finger of two ends the pinch, the other keeps dragging', () => {
    const { cam, g } = setup(60, 1000, 500);
    g.down(1, 400, 250, 0);
    g.down(2, 600, 250, 0);
    g.tick(0);
    g.up(2, 10);
    g.tick(10);
    const fov = cam.fov;
    const yaw = cam.yaw;
    g.move(1, 500, 250, 20);
    g.tick(20);
    expect(cam.fov).toBe(fov);
    expect(cam.yaw).not.toBe(yaw);
  });
});

describe('wheel and keys', () => {
  test('wheel zooms exponentially and symmetrically', () => {
    const { cam, g } = setup(60);
    g.wheel(-500);
    const zoomedIn = cam.fov;
    expect(zoomedIn).toBeLessThan(60);
    g.wheel(500);
    expect(cam.fov).toBeCloseTo(60, 6);
  });

  test('arrow keys turn by a fraction of the fov', () => {
    const { cam, g } = setup(60);
    expect(g.key('ArrowRight')).toBe(true);
    expect(cam.yaw).toBeCloseTo(90 + 60 * 0.08, 6);
    expect(g.key('ArrowUp')).toBe(true);
    expect(cam.pitch).toBeCloseTo(60 * 0.08, 6);
    expect(g.key('x')).toBe(false);
  });

  test('every applied change reports once, idle frames report nothing', () => {
    const { g } = setup(60);
    let n = 0;
    g.onChange = () => n++;
    g.wheel(100);
    g.key('ArrowLeft');
    g.down(1, 0, 0, 0); g.move(1, 10, 0, 5); g.tick(5);
    g.up(1, 400);                   // a slow release: no flick, so nothing more to report
    g.tick(500); g.tick(516);
    expect(n).toBe(3);
  });
});
