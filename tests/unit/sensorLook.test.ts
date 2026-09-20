/**
 * The view axis from the device's sensors, as a pure model: orientation
 * readings go into the pose tracker, `tick` sets the camera once per frame,
 * and a drag shifts a persisted correction instead of fighting the compass.
 */
import { describe, expect, test } from 'bun:test';
import { Camera } from '../../src/engine/core/camera';
import { angleDelta, declinationAt } from '../../src/engine/core/pose';
import { OFFSET_KEY, SensorLook, SensorPlatform } from '../../src/app/sensorLook';

const HZ = 60, DT = 1000 / HZ;
/** A phone held upright at the horizon, facing magnetic `yaw`. */
const upright = (yaw: number) => ({ alpha: (360 - yaw) % 360, beta: 90, gamma: 0, absolute: true });

class MemoryStore {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

function setup(platform: Partial<SensorPlatform> = {}, store = new MemoryStore()) {
  const cam = new Camera();
  cam.set({ yaw: 200, pitch: 10, fov: 60 });
  const s = new SensorLook(cam, { store, requestPermission: async () => true, listen: () => () => {}, ...platform });
  s.setPosition(10.0, 47.0);
  return { cam, s, store };
}

/** Feeds the same reading for `seconds` and ticks every frame. */
function settle(s: SensorLook, reading: { alpha: number; beta: number; gamma: number; absolute: boolean }, seconds = 3, from = 0) {
  let changed = false;
  for (let i = 0; i < seconds * HZ; i++) {
    s.pose.handleOrientation(reading, true, 0);
    changed = s.tick(from + i * DT) || changed;
  }
  return changed;
}

describe('SensorLook', () => {
  test('inactive, the sensors leave the camera alone', () => {
    const { cam, s } = setup();
    expect(settle(s, upright(90))).toBe(false);
    expect(cam.yaw).toBe(200);
    expect(cam.pitch).toBe(10);
  });

  test('active, the camera follows the true heading (magnetic plus declination) and the pitch', async () => {
    const { cam, s } = setup();
    await s.start();
    expect(s.active).toBe(true);
    expect(settle(s, upright(90))).toBe(true);
    const decl = declinationAt(10.0, 47.0);
    expect(decl).toBeGreaterThan(2);
    expect(Math.abs(angleDelta(cam.yaw, 90 + decl))).toBeLessThan(0.5);
    expect(Math.abs(cam.pitch)).toBeLessThan(0.5);
    settle(s, { ...upright(90), beta: 70 }, 3, 3000);
    expect(cam.pitch).toBeCloseTo(-20, 0);
  });

  test('a nudge shifts the view and sticks while the sensors keep reporting', async () => {
    const { cam, s } = setup();
    await s.start();
    settle(s, upright(90));
    const before = cam.yaw;
    s.nudge(-10, 5);
    expect(s.offsetYaw).toBeCloseTo(-10, 6);
    expect(s.offsetPitch).toBe(5);
    settle(s, upright(90), 3, 3000);
    expect(Math.abs(angleDelta(cam.yaw, before - 10))).toBeLessThan(0.5);
    expect(cam.pitch).toBeCloseTo(5, 0);
  });

  test('the correction is persisted and restored, and reset clears it', async () => {
    const { s, store } = setup();
    await s.start();
    s.nudge(-10, 5);
    expect(JSON.parse(store.getItem(OFFSET_KEY)!)).toEqual({ yaw: -10, pitch: 5 });
    const again = setup({}, store);
    expect(again.s.offsetYaw).toBeCloseTo(-10, 6);
    expect(again.s.offsetPitch).toBe(5);
    again.s.resetOffset();
    expect(again.s.offsetYaw).toBe(0);
    expect(store.getItem(OFFSET_KEY)).toBeNull();
  });

  test('the pitch correction is clamped to ±45°, the yaw one wraps', async () => {
    const { s } = setup();
    await s.start();
    s.nudge(370, 80);
    expect(s.offsetYaw).toBeCloseTo(10, 6);
    expect(s.offsetPitch).toBe(45);
    s.nudge(-30, -100);
    expect(s.offsetYaw).toBeCloseTo(-20, 6);
    expect(s.offsetPitch).toBe(-45);
  });

  test('refused motion access is a readable error and leaves the view inactive', async () => {
    let listening = 0;
    const { s, cam } = setup({ requestPermission: async () => false, listen: () => { listening++; return () => {}; } });
    await expect(s.start()).rejects.toThrow('Sensoren nicht verfügbar: Zugriff verweigert.');
    expect(s.active).toBe(false);
    expect(listening).toBe(0);
    settle(s, upright(90));
    expect(cam.yaw).toBe(200);
  });

  test('stop keeps the last view and detaches the listeners', async () => {
    let detached = 0;
    const { s, cam } = setup({ listen: () => () => { detached++; } });
    await s.start();
    settle(s, upright(90));
    const yaw = cam.yaw;
    s.stop();
    expect(s.active).toBe(false);
    expect(detached).toBe(1);
    expect(settle(s, upright(180), 3, 3000)).toBe(false);
    expect(cam.yaw).toBe(yaw);
  });

  test('a restart takes the first reading whole instead of easing in from the old view', async () => {
    const { s, cam } = setup();
    await s.start();
    settle(s, upright(90));
    s.stop();
    await s.start();
    s.pose.handleOrientation(upright(270), true, 0);
    s.tick(10_000);
    s.pose.handleOrientation(upright(270), true, 0);
    s.tick(10_000 + DT);
    expect(Math.abs(angleDelta(cam.yaw, 270 + declinationAt(10.0, 47.0)))).toBeLessThan(1);
  });
});
