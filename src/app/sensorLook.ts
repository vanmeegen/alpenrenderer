/**
 * The view axis from the device's sensors.
 *
 * The pose tracker fuses compass and gyro into a heading; this model turns
 * that into the camera once per frame and owns the one thing the sensors
 * cannot know: the manual correction. A compass in the Alps can be 10 to 40
 * degrees off, so a drag in sensor mode does not turn the camera (the next
 * reading would turn it straight back) but shifts an offset that is applied
 * on top of every reading, shown in the HUD, and kept in storage so the
 * correction survives a reload.
 *
 * No DOM here beyond what `SensorPlatform` injects; the tests drive it with
 * synthetic readings and a memory store.
 */

import { Camera } from '../engine/core/camera';
import { PoseTracker, screenAngle } from '../engine/core/pose';

export const OFFSET_KEY = 'alp.sensorOffset';
const MAX_PITCH_OFFSET = 45;

export interface SensorPlatform {
  /** Where the correction is kept; `localStorage` in the app. */
  store?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** iOS asks; everywhere else this resolves true. */
  requestPermission?: () => Promise<boolean>;
  /** Attaches the sensor events to the tracker; returns the detach. */
  listen?: (pose: PoseTracker) => () => void;
}

/** The DeviceOrientation and DeviceMotion events of the real window. */
function listenToWindow(pose: PoseTracker): () => void {
  const onAbsolute = (e: Event) => pose.handleOrientation(e as DeviceOrientationEvent, true, screenAngle());
  const onRelative = (e: Event) => pose.handleOrientation(e as DeviceOrientationEvent, false, screenAngle());
  const onMotion = (e: Event) => {
    const r = (e as DeviceMotionEvent).rotationRate;
    if (!r || r.alpha === null) return;
    // rotationRate's alpha, beta, gamma are rates about the device's z, x
    // and y axes, not the Euler angles of the same names.
    pose.feedGyro(r.beta ?? 0, r.gamma ?? 0, r.alpha ?? 0);
  };
  window.addEventListener('deviceorientationabsolute', onAbsolute);
  window.addEventListener('deviceorientation', onRelative);
  window.addEventListener('devicemotion', onMotion);
  return () => {
    window.removeEventListener('deviceorientationabsolute', onAbsolute);
    window.removeEventListener('deviceorientation', onRelative);
    window.removeEventListener('devicemotion', onMotion);
  };
}

const norm180 = (deg: number) => ((deg + 540) % 360 + 360) % 360 - 180;

export class SensorLook {
  readonly pose = new PoseTracker({});
  active = false;
  /** Vertical correction, degrees; the horizontal one lives on the pose. */
  offsetPitch = 0;
  private readonly store: SensorPlatform['store'];
  private readonly ask: () => Promise<boolean>;
  private readonly listen: (pose: PoseTracker) => () => void;
  private detach: (() => void) | null = null;

  constructor(readonly camera: Camera, platform: SensorPlatform = {}) {
    this.store = platform.store === undefined
      ? (typeof localStorage !== 'undefined' ? localStorage : null) : platform.store;
    this.ask = platform.requestPermission ?? (() => this.pose.requestPermission());
    this.listen = platform.listen ?? listenToWindow;
    this.restore();
  }

  /** Signed horizontal correction, degrees in (-180, 180]. */
  get offsetYaw(): number { return norm180(this.pose.status.offset); }

  setPosition(lon: number, lat: number) { this.pose.setPosition(lon, lat); }

  /** Shifts the correction by what a drag reported and applies it at once. */
  nudge(dYaw: number, dPitch: number) {
    this.pose.nudgeOffset(dYaw);
    this.offsetPitch = Math.max(-MAX_PITCH_OFFSET, Math.min(MAX_PITCH_OFFSET, this.offsetPitch + dPitch));
    this.persist();
    if (this.active) this.apply();
  }

  resetOffset() {
    this.pose.setOffset(0);
    this.offsetPitch = 0;
    try { this.store?.removeItem(OFFSET_KEY); } catch { /* storage may be unavailable */ }
    if (this.active) this.apply();
  }

  /** Asks for motion access (iOS) and starts following the sensors. */
  async start(): Promise<void> {
    if (this.active) return;
    const ok = await this.ask();
    if (!ok) throw new Error('Sensoren nicht verfügbar: Zugriff verweigert.');
    this.detach = this.listen(this.pose);
    this.active = true;
  }

  /** The view stays where the sensors left it. */
  stop() {
    this.detach?.();
    this.detach = null;
    this.active = false;
    this.pose.resetFusion();
  }

  /** Once per frame; returns whether the camera changed. */
  tick(now: number): boolean {
    if (!this.active || !this.pose.status.hasOrientation) return false;
    this.pose.sample(now);
    return this.apply();
  }

  private apply(): boolean {
    const o = this.pose.orientation;
    const yaw = o.yaw, pitch = o.pitch + this.offsetPitch;
    if (yaw === this.camera.yaw && pitch === this.camera.pitch) return false;
    this.camera.set({ yaw, pitch });
    return true;
  }

  private persist() {
    try {
      this.store?.setItem(OFFSET_KEY, JSON.stringify({ yaw: this.offsetYaw, pitch: this.offsetPitch }));
    } catch { /* storage may be unavailable */ }
  }

  private restore() {
    try {
      const raw = this.store?.getItem(OFFSET_KEY);
      if (!raw) return;
      const o = JSON.parse(raw) as { yaw?: number; pitch?: number };
      if (Number.isFinite(o.yaw)) this.pose.setOffset(o.yaw!);
      if (Number.isFinite(o.pitch)) this.offsetPitch = Math.max(-MAX_PITCH_OFFSET, Math.min(MAX_PITCH_OFFSET, o.pitch!));
    } catch { /* ignore a broken entry */ }
  }
}
