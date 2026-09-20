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
/** Inertia decays by this factor per 16 ms frame; integrated exactly over any dt. */
const DECAY = 0.93;
const LN_DECAY = Math.log(DECAY);
const FRAME_MS = 16;
const STOP_PX = 0.05;
const KEY_STEP = 0.08;
/** A touch that moves less than this and lifts within this time is a tap. */
const TAP_PX = 8;
const TAP_MS = 300;

export class GestureModel {
  onChange: (() => void) | null = null;
  /**
   * When set, turning is reported here in degrees instead of applied to the
   * camera: in sensor mode a drag corrects the compass rather than fighting
   * it. Zoom is never redirected.
   */
  turnHandler: ((dYaw: number, dPitch: number) => void) | null = null;
  /** A short single touch that did not move: a tap at that point. */
  onTap: ((x: number, y: number) => void) | null = null;
  minFov = 8;
  maxFov = 100;

  private pointers = new Map<number, Pointer>();
  /** Centroid and spread as of the last applied frame. */
  private lastCentroid: Pointer | null = null;
  private pinchStart = 0;
  private fovStart = 0;
  /** Velocity for inertia in px per 16 ms frame, and the last applied delta with its time span. */
  private vx = 0;
  private vy = 0;
  private lastDx = 0;
  private lastDy = 0;
  private lastSpan = FRAME_MS;
  private lastApply = 0;
  private lastMove = -Infinity;
  private lastTick = 0;
  /** Where and when the single finger went down, until it moves or a second one joins. */
  private tapStart: { x: number; y: number; t: number } | null = null;

  constructor(readonly camera: Camera, readonly size: () => Size) {}

  /** Degrees of world per CSS pixel, horizontally and vertically. */
  private degPerPx(): { x: number; y: number } {
    const { width, height } = this.size();
    return { x: this.camera.hfov / (width || 1), y: this.camera.fov / (height || 1) };
  }

  private turn(dxPx: number, dyPx: number): boolean {
    if (dxPx === 0 && dyPx === 0) return false;
    const s = this.degPerPx();
    return this.turnBy(-dxPx * s.x, dyPx * s.y);
  }

  private turnBy(dYaw: number, dPitch: number): boolean {
    if (this.turnHandler) { this.turnHandler(dYaw, dPitch); return true; }
    const yaw = this.camera.yaw + dYaw;
    this.camera.set({ yaw: yaw - 360 * Math.floor(yaw / 360), pitch: this.camera.pitch + dPitch });
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

  /**
   * Applies what the fingers did since the last frame: the pinch, then the
   * centroid's travel. Called once per frame, and whenever the set of fingers
   * is about to change, so a slow renderer never drops the tail of a drag.
   */
  private apply(t: number): boolean {
    if (this.pointers.size === 0 || !this.lastCentroid) return false;
    let changed = false;
    if (this.pinchStart > 0) {
      const spread = this.spread();
      if (spread > 0) changed = this.setFov(this.fovStart * (this.pinchStart / spread)) || changed;
    }
    const c = this.centroid();
    const dx = c.x - this.lastCentroid.x, dy = c.y - this.lastCentroid.y;
    this.lastCentroid = c;
    changed = this.turn(dx, dy) || changed;
    if (dx !== 0 || dy !== 0) {
      this.lastDx = dx; this.lastDy = dy;
      this.lastSpan = Math.max(1, t - this.lastApply);
    }
    this.lastApply = t;
    return changed;
  }

  down(id: number, x: number, y: number, t: number) {
    if (this.apply(t)) this.onChange?.();
    this.pointers.set(id, { x, y });
    this.tapStart = this.pointers.size === 1 ? { x, y, t } : null;
    this.vx = this.vy = 0;
    this.lastApply = t;
    this.rebase();
  }

  move(id: number, x: number, y: number, t: number) {
    const p = this.pointers.get(id);
    if (!p) return;
    p.x = x; p.y = y;
    this.lastMove = t;
    if (this.tapStart && Math.hypot(x - this.tapStart.x, y - this.tapStart.y) > TAP_PX) this.tapStart = null;
  }

  up(id: number, t: number) {
    if (!this.pointers.has(id)) return;
    if (this.apply(t)) this.onChange?.();
    this.pointers.delete(id);
    const tap = this.tapStart;
    this.tapStart = null;
    if (tap && t - tap.t < TAP_MS) this.onTap?.(tap.x, tap.y);
    if (this.pointers.size === 0 && t - this.lastMove < FLICK_MS) {
      // Velocity in px per frame from the last applied delta and its span,
      // so a flick carries the same distance at any frame rate.
      const k = FRAME_MS / this.lastSpan;
      this.vx = this.lastDx * k; this.vy = this.lastDy * k;
      this.lastTick = t;
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
      case 'ArrowLeft': this.turnBy(-step, 0); break;
      case 'ArrowRight': this.turnBy(step, 0); break;
      case 'ArrowUp': this.turnBy(0, step); break;
      case 'ArrowDown': this.turnBy(0, -step); break;
      case '+': case '=': this.setFov(this.camera.fov * 0.8); break;
      case '-': case '_': this.setFov(this.camera.fov * 1.25); break;
      default: return false;
    }
    this.onChange?.();
    return true;
  }

  /** Once per frame: applies what the fingers did since the last frame, or inertia. */
  tick(t: number = 0) {
    let changed = false;
    if (this.pointers.size > 0) {
      changed = this.apply(t);
    } else if (Math.abs(this.vx) + Math.abs(this.vy) >= STOP_PX) {
      // Exact integral of an exponentially decaying velocity over the frame,
      // whatever its length: the distance covered does not depend on fps.
      const frames = Math.min(50, Math.max(0.05, (t - this.lastTick) / FRAME_MS));
      const decay = Math.pow(DECAY, frames);
      const travel = (decay - 1) / LN_DECAY;      // in frames' worth of velocity
      changed = this.turn(this.vx * travel, this.vy * travel);
      this.vx *= decay;
      this.vy *= decay;
    } else {
      this.vx = this.vy = 0;
    }
    this.lastTick = t;
    if (changed) this.onChange?.();
  }
}
