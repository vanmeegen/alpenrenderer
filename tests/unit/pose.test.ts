/**
 * Characterisation of the sensor fusion in src/engine/core/pose.ts, ported
 * from peakviewer's tools/check_pose.mjs: the heading must settle when the
 * phone is still, keep up when it turns, ignore a disturbed compass, believe
 * only one of Android's two orientation events, and do its work once per
 * frame rather than once per sensor event.
 */
import { describe, expect, test } from 'bun:test';
import { AngleFilter, PoseTracker, angleDelta, declinationAt, orientationFromEuler } from '../../src/engine/core/pose';

let seed = 4242;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

/** A phone held upright at the horizon, facing `yaw`: the Euler angles for that pose. */
const upright = (yaw: number) => ({ alpha: (360 - yaw) % 360, beta: 90, gamma: 0 });

const HZ = 60;
const DT = 1000 / HZ;

function run(opt: { seconds: number; yawAt: (t: number) => number; compassNoise?: number; gyro?: boolean }) {
  const p = new PoseTracker({});
  p.applyDeclination = false;
  const out: { t: number; truth: number; yaw: number }[] = [];
  const n = Math.round(opt.seconds * HZ);
  let prevYaw = opt.yawAt(0);
  for (let i = 0; i < n; i++) {
    const t = i / HZ;
    const truth = opt.yawAt(t);
    const e = upright(truth + (opt.compassNoise ?? 0) * (rnd() * 2 - 1));
    p.feedOrientation(e.alpha, e.beta, e.gamma, 0);
    if (opt.gyro !== false) {
      // Turning about world up with the phone upright: the device's +y axis
      // points at the sky, so that is where the rate goes.
      p.feedGyro(0, -angleDelta(truth, prevYaw) * HZ, 0);
    }
    prevYaw = truth;
    const o = p.sample(i * DT);
    out.push({ t, truth, yaw: o.yaw });
  }
  return out;
}

describe('orientationFromEuler', () => {
  test('a phone held upright facing east looks along bearing 90 at the horizon', () => {
    const o = orientationFromEuler(270, 90, 0);
    expect(o.yaw).toBeCloseTo(90, 6);
    expect(o.pitch).toBeCloseTo(0, 6);
    expect(o.roll).toBeCloseTo(0, 6);
  });

  test('beta 70 is looking 20 degrees down', () => {
    expect(orientationFromEuler(0, 70, 0).pitch).toBeCloseTo(-20, 6);
  });

  test('landscape: the screen angle turns only the roll, by exactly its amount', () => {
    const o0 = orientationFromEuler(30, 60, 20, 0);
    const o90 = orientationFromEuler(30, 60, 20, 90);
    expect(o90.yaw).toBeCloseTo(o0.yaw, 6);
    expect(o90.pitch).toBeCloseTo(o0.pitch, 6);
    expect(Math.abs(angleDelta(o90.roll, o0.roll))).toBeCloseTo(90, 6);
  });
});

describe('declinationAt', () => {
  test('is a few degrees east in the Alps and zero on failure', () => {
    const d = declinationAt(10.0, 47.0, new Date('2026-09-20'));
    expect(d).toBeGreaterThan(2);
    expect(d).toBeLessThan(6);
    expect(declinationAt(NaN, NaN)).toBe(0);
  });
});

describe('AngleFilter', () => {
  test('crosses the 0/360 seam without a full spin', () => {
    const f = new AngleFilter(1, 0.03);
    f.filter(358, 1 / 60);
    for (let i = 0; i < 120; i++) f.filter(2, 1 / 60);
    expect(Math.abs(angleDelta(f.current, 2))).toBeLessThan(0.5);
  });
});

describe('PoseTracker', () => {
  test('held still against a magnetometer noisy by ±3°: the jitter is filtered out', () => {
    const out = run({ seconds: 6, yawAt: () => 42, compassNoise: 3 });
    const tail = out.slice(HZ * 2);
    const rms = Math.sqrt(tail.reduce((a, r) => a + angleDelta(r.yaw, 42) ** 2, 0) / tail.length);
    // Uniform ±3° has an RMS of 1.73°; anything near that is unfiltered.
    expect(rms).toBeLessThan(0.45);
  });

  test('turning at 60°/s: keeps up within 4°', () => {
    const out = run({ seconds: 4, yawAt: (t) => (20 + 60 * t) % 360, compassNoise: 1.5 });
    const tail = out.slice(HZ * 2);
    const lag = tail.reduce((a, r) => a + angleDelta(r.truth, r.yaw), 0) / tail.length;
    expect(Math.abs(lag)).toBeLessThan(4);
  });

  test('a ferrous object swings the compass 40° for half a second: the view does not chase it', () => {
    const p = new PoseTracker({});
    p.applyDeclination = false;
    let worst = 0;
    for (let i = 0; i < 6 * HZ; i++) {
      const t = i / HZ;
      const disturbed = t > 2 && t < 2.5 ? 40 : 0;
      const e = upright(42 + disturbed);
      p.feedOrientation(e.alpha, e.beta, e.gamma, 0);
      p.feedGyro(0, 0, 0);            // the gyro says: not turning
      const o = p.sample(i * DT);
      if (t > 1) worst = Math.max(worst, Math.abs(angleDelta(o.yaw, 42)));
    }
    expect(worst).toBeLessThan(12);
  });

  test('both DeviceOrientation events firing 137° apart: the relative twin is ignored', () => {
    const p = new PoseTracker({});
    p.applyDeclination = false;
    const seen: number[] = [];
    for (let i = 0; i < 4 * HZ; i++) {
      p.handleOrientation({ ...upright(42), absolute: true }, true, 0);
      p.handleOrientation({ ...upright(179) }, false, 0);
      seen.push(p.sample(i * DT).yaw);
    }
    const worst = Math.max(...seen.slice(HZ * 2).map((y) => Math.abs(angleDelta(y, 42))));
    expect(worst).toBeLessThan(1);
  });

  test('iOS, with no absolute event, uses webkitCompassHeading as a true heading', () => {
    const q = new PoseTracker({});
    q.applyDeclination = false;
    for (let i = 0; i < 3 * HZ; i++) {
      q.handleOrientation({ ...upright(0), webkitCompassHeading: 318 }, false, 0);
      q.sample(i * DT);
    }
    expect(Math.abs(angleDelta(q.orientation.yaw, 318))).toBeLessThan(1);
    expect(q.status.headingIsTrue).toBe(true);
  });

  test('a magnetic heading gets the declination and the manual offset added', () => {
    const p = new PoseTracker({});
    p.setPosition(10.0, 47.0);
    p.setOffset(-5);
    for (let i = 0; i < 3 * HZ; i++) {
      p.handleOrientation({ ...upright(90), absolute: true }, true, 0);
      p.sample(i * DT);
    }
    expect(p.status.offset).toBe(355);
    expect(Math.abs(angleDelta(p.orientation.yaw, 90 + p.status.declination - 5))).toBeLessThan(0.5);
  });

  test('pitch below the horizon reads negative, not 340', () => {
    const p = new PoseTracker({});
    p.applyDeclination = false;
    let last = 0;
    for (let i = 0; i < 3 * HZ; i++) {
      p.feedOrientation(0, 70, 0, 0);
      last = p.sample(i * DT).pitch;
    }
    expect(last).toBeLessThan(0);
    expect(last).toBeGreaterThan(-40);
  });

  test('after resetFusion the next reading is taken whole, not eased in from the old heading', () => {
    const p = new PoseTracker({});
    p.applyDeclination = false;
    for (let i = 0; i < 2 * HZ; i++) { p.feedOrientation(270, 90, 0, 0); p.sample(i * DT); }
    expect(Math.abs(angleDelta(p.orientation.yaw, 90))).toBeLessThan(0.5);
    p.resetFusion();
    expect(p.status.hasOrientation).toBe(false);
    expect(p.sample(10_000)).toBe(p.orientation);        // nothing to fuse from: unchanged
    p.feedOrientation(90, 90, 0, 0);
    p.sample(10_016);
    p.feedOrientation(90, 90, 0, 0);
    p.sample(10_032);
    expect(Math.abs(angleDelta(p.orientation.yaw, 270))).toBeLessThan(0.5);
  });

  test('the compass pull is a matter of wall time, not frame count: 2 fps settles like 60 fps', () => {
    // A slow renderer (software WebGL) draws two frames a second. After a
    // 180° turn the heading must still be on the compass five seconds later,
    // exactly as it would be at 60 fps.
    const settle = (fps: number) => {
      const p = new PoseTracker({});
      p.applyDeclination = false;
      for (let i = 0; i < 2 * HZ; i++) { p.feedOrientation(270, 90, 0, 0); p.sample(i * DT); }
      expect(Math.abs(angleDelta(p.orientation.yaw, 90))).toBeLessThan(0.5);
      const t0 = 2 * HZ * DT, frame = 1000 / fps;
      for (let i = 1; i <= 5 * fps; i++) { p.feedOrientation(90, 90, 0, 0); p.sample(t0 + i * frame); }
      return Math.abs(angleDelta(p.orientation.yaw, 270));
    };
    expect(settle(60)).toBeLessThan(0.5);
    expect(settle(2)).toBeLessThan(0.5);
  });

  test('one update per frame, not one per sensor event', () => {
    let calls = 0;
    const p = new PoseTracker({ onOrientation: () => { calls++; } });
    for (let i = 0; i < 60; i++) {
      p.feedOrientation(0, 90, 0, 0);
      p.feedOrientation(0, 90, 0, 0);
      p.feedGyro(0, 0, 0);
      p.feedGyro(0, 0, 0);
      p.sample(i * DT);
    }
    expect(calls).toBe(60);
  });
});

describe('PoseTracker.requestPermission', () => {
  type Req = { requestPermission?: () => Promise<string> };
  const g = globalThis as unknown as { DeviceOrientationEvent?: Req; DeviceMotionEvent?: Req; window?: unknown };

  test('a platform without the gate (Android, desktop) is granted at once', async () => {
    g.DeviceOrientationEvent = {};
    g.window = { DeviceMotionEvent: {} };
    const p = new PoseTracker({});
    expect(await p.requestPermission()).toBe(true);
    expect(p.status.permission).toBe('granted');
  });

  test('a refused orientation request is denied', async () => {
    g.DeviceOrientationEvent = { requestPermission: async () => 'denied' };
    g.window = { DeviceMotionEvent: {} };
    const p = new PoseTracker({});
    expect(await p.requestPermission()).toBe(false);
    expect(p.status.permission).toBe('denied');
  });

  test('"prompt" (the browser could not ask, as Chrome 153 answers headless) is not a refusal', async () => {
    g.DeviceOrientationEvent = { requestPermission: async () => 'prompt' };
    g.window = { DeviceMotionEvent: { requestPermission: async () => 'prompt' } };
    const p = new PoseTracker({});
    expect(await p.requestPermission()).toBe(true);
    expect(p.status.permission).toBe('unknown');
  });

  test('a failing motion request does not revoke a granted orientation permission', async () => {
    // Orientation is what the view needs; the motion (gyro) request is a
    // bonus and, once the first await has spent the user activation, may
    // well be rejected. That must not read as a refusal.
    g.DeviceOrientationEvent = { requestPermission: async () => 'granted' };
    g.window = { DeviceMotionEvent: { requestPermission: async () => { throw new Error('needs a user gesture'); } } };
    const p = new PoseTracker({});
    expect(await p.requestPermission()).toBe(true);
    expect(p.status.permission).toBe('granted');
  });
});
