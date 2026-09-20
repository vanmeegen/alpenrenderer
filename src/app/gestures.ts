/**
 * Look-around gestures for a panorama, as a pure model: pointer coordinates
 * and timestamps in, camera changes out. No DOM here; `LookControls` is the
 * adapter that feeds it events.
 *
 *   one finger / mouse drag   yaw and pitch, the terrain follows the finger
 *   two fingers               pinch zooms the field of view; their midpoint
 *                             still turns the view
 *   wheel                     zoom
 *   arrow keys                turn, +/- zoom
 *
 * Pointer positions are recorded as they arrive and applied once per frame in
 * `tick()`. Two fingers report as two separate events, and applying each on
 * its own would zoom with a spread that is only half updated and turn with the
 * wrong field of view in between; per frame, both fingers have moved.
 *
 * Turning is scaled by the field of view so a drag of one screen width always
 * sweeps one screen width of world, whatever the zoom. A flick keeps turning
 * with decaying velocity, which is what makes it feel like a map rather than
 * a slider.
 */

import { Camera } from '../engine/core/camera';

interface Pointer { x: number; y: number }
export interface Size { width: number; height: number }

/** Release within this many ms of the last move counts as a flick. */
const FLICK_MS = 60;
const DECAY = 0.93;
const STOP_PX = 0.05;
const KEY_STEP = 0.08;

export class GestureModel {
  onChange: (() => void) | null = null;
  minFov = 8;
  maxFov = 100;

  private pointers = new Map<number, Pointer>();
  /** Centroid and spread as of the last applied frame. */
  private lastCentroid: Pointer | null = null;
  private pinchStart = 0;
  private fovStart = 0;
  /** Velocity for inertia, in px per frame, and the last frame's delta. */
  private vx = 0;
  private vy = 0;
  private lastDx = 0;
  private lastDy = 0;
  private lastMove = -Infinity;

  constructor(readonly camera: Camera, readonly size: () => Size) {}

  /** Degrees of world per CSS pixel, horizontally and vertically. */
  private degPerPx(): { x: number; y: number } {
    const { width, height } = this.size();
    return { x: this.camera.hfov / (width || 1), y: this.camera.fov / (height || 1) };
  }

  private turn(dxPx: number, dyPx: number): boolean {
    if (dxPx === 0 && dyPx === 0) return false;
    const s = this.degPerPx();
    const yaw = this.camera.yaw - dxPx * s.x;
    this.camera.set({ yaw: yaw - 360 * Math.floor(yaw / 360), pitch: this.camera.pitch + dyPx * s.y });
    return true;
  }

  private setFov(fov: number): boolean {
    const clamped = Math.max(this.minFov, Math.min(this.maxFov, fov));
    if (clamped === this.camera.fov) return false;
    this.camera.set({ fov: clamped });
    return true;
  }

  private centroid(): Pointer {
    let x = 0, y = 0;
    for (const p of this.pointers.values()) { x += p.x; y += p.y; }
    const n = this.pointers.size || 1;
    return { x: x / n, y: y / n };
  }

  private spread(): number {
    const ps = [...this.pointers.values()];
    return ps.length < 2 ? 0 : Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
  }

  /** The set of fingers changed: restart the reference frame so nothing jumps. */
  private rebase() {
    this.lastCentroid = this.pointers.size ? this.centroid() : null;
    if (this.pointers.size === 2) {
      this.pinchStart = this.spread();
      this.fovStart = this.camera.fov;
    } else {
      this.pinchStart = 0;
    }
  }

  down(id: number, x: number, y: number, _t: number) {
    this.pointers.set(id, { x, y });
    this.vx = this.vy = 0;
    this.rebase();
  }

  move(id: number, x: number, y: number, t: number) {
    const p = this.pointers.get(id);
    if (!p) return;
    p.x = x; p.y = y;
    this.lastMove = t;
  }

  up(id: number, t: number) {
    if (!this.pointers.delete(id)) return;
    if (this.pointers.size === 0 && t - this.lastMove < FLICK_MS) {
      this.vx = this.lastDx; this.vy = this.lastDy;
    }
    this.rebase();
  }

  wheel(deltaY: number) {
    if (this.setFov(this.camera.fov * Math.exp(deltaY * 0.0012))) this.onChange?.();
  }

  /** Returns whether the key was one of ours. */
  key(key: string): boolean {
    const step = this.camera.fov * KEY_STEP;
    switch (key) {
      case 'ArrowLeft': this.camera.set({ yaw: this.camera.yaw - step }); break;
      case 'ArrowRight': this.camera.set({ yaw: this.camera.yaw + step }); break;
      case 'ArrowUp': this.camera.set({ pitch: this.camera.pitch + step }); break;
      case 'ArrowDown': this.camera.set({ pitch: this.camera.pitch - step }); break;
      case '+': case '=': this.setFov(this.camera.fov * 0.8); break;
      case '-': case '_': this.setFov(this.camera.fov * 1.25); break;
      default: return false;
    }
    this.onChange?.();
    return true;
  }

  /** Once per frame: applies what the fingers did since the last frame, or inertia. */
  tick(_t: number = 0) {
    let changed = false;
    if (this.pointers.size > 0 && this.lastCentroid) {
      if (this.pinchStart > 0) {
        const spread = this.spread();
        if (spread > 0) changed = this.setFov(this.fovStart * (this.pinchStart / spread)) || changed;
      }
      const c = this.centroid();
      const dx = c.x - this.lastCentroid.x, dy = c.y - this.lastCentroid.y;
      this.lastCentroid = c;
      changed = this.turn(dx, dy) || changed;
      this.lastDx = dx; this.lastDy = dy;
    } else if (Math.abs(this.vx) + Math.abs(this.vy) >= STOP_PX) {
      changed = this.turn(this.vx, this.vy);
      this.vx *= DECAY;
      this.vy *= DECAY;
    } else {
      this.vx = this.vy = 0;
    }
    if (changed) this.onChange?.();
  }
}
