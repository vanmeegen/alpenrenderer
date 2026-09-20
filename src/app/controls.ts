/**
 * Look-around controls for a panorama: the eye stays where it is, the finger
 * turns the head.
 *
 *   one finger / mouse drag   yaw and pitch, the terrain follows the finger
 *   two fingers               pinch zooms the field of view; their midpoint
 *                             still turns the view
 *   wheel                     zoom
 *   arrow keys                turn, +/- zoom
 *
 * Turning is scaled by the field of view so a drag of one screen width always
 * sweeps one screen width of world, whatever the zoom. A flick keeps turning
 * with decaying velocity, which is what makes it feel like a map rather than
 * a slider.
 */

import { Camera } from '../engine/core/camera';

interface Pointer { id: number; x: number; y: number }

export class LookControls {
  /** Set to be told when the view changed (for the URL, mostly). */
  onChange: (() => void) | null = null;
  minFov = 8;
  maxFov = 100;

  private pointers = new Map<number, Pointer>();
  private pinchStart = 0;
  private fovStart = 0;
  private vx = 0;
  private vy = 0;
  private lastMove = 0;
  private lastDx = 0;
  private lastDy = 0;
  private detach: (() => void)[] = [];

  constructor(readonly el: HTMLElement, readonly camera: Camera) {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K, fn: (e: HTMLElementEventMap[K]) => void, opt?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn, opt);
      this.detach.push(() => el.removeEventListener(type, fn, opt));
    };
    on('pointerdown', this.down, { passive: false });
    on('pointermove', this.move, { passive: false });
    on('pointerup', this.up);
    on('pointercancel', this.up);
    on('wheel', this.wheel, { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    const key = (e: KeyboardEvent) => this.key(e);
    window.addEventListener('keydown', key);
    this.detach.push(() => window.removeEventListener('keydown', key));
  }

  dispose() { for (const d of this.detach) d(); }

  /** Degrees of world per CSS pixel, horizontally and vertically. */
  private degPerPx(): { x: number; y: number } {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    return { x: this.camera.hfov / w, y: this.camera.fov / h };
  }

  private turn(dxPx: number, dyPx: number) {
    const s = this.degPerPx();
    this.camera.set({
      yaw: (((this.camera.yaw - dxPx * s.x) % 360) + 360) % 360,
      pitch: this.camera.pitch + dyPx * s.y,
    });
    this.onChange?.();
  }

  private zoomBy(factor: number) {
    this.camera.set({ fov: Math.max(this.minFov, Math.min(this.maxFov, this.camera.fov * factor)) });
    this.onChange?.();
  }

  private centroid(): { x: number; y: number } {
    let x = 0, y = 0;
    for (const p of this.pointers.values()) { x += p.x; y += p.y; }
    const n = this.pointers.size || 1;
    return { x: x / n, y: y / n };
  }

  private spread(): number {
    const ps = [...this.pointers.values()];
    if (ps.length < 2) return 0;
    return Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });
    this.vx = this.vy = 0;
    if (this.pointers.size === 2) {
      this.pinchStart = this.spread();
      this.fovStart = this.camera.fov;
    }
  };

  private move = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const before = this.centroid();
    p.x = e.clientX; p.y = e.clientY;
    const after = this.centroid();
    const dx = after.x - before.x, dy = after.y - before.y;
    if (this.pointers.size === 2 && this.pinchStart > 0) {
      const spread = this.spread();
      if (spread > 0) {
        const fov = this.fovStart * (this.pinchStart / spread);
        this.camera.set({ fov: Math.max(this.minFov, Math.min(this.maxFov, fov)) });
      }
    }
    this.turn(dx, dy);
    const now = performance.now();
    this.lastDx = dx; this.lastDy = dy; this.lastMove = now;
  };

  private up = (e: PointerEvent) => {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size === 0) {
      // A flick: carry the last motion on as velocity, decayed per frame.
      if (performance.now() - this.lastMove < 60) {
        this.vx = this.lastDx; this.vy = this.lastDy;
      }
    } else if (this.pointers.size === 1) {
      this.pinchStart = 0;
    }
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoomBy(Math.exp(e.deltaY * 0.0012));
  };

  private key(e: KeyboardEvent) {
    const step = this.camera.fov * 0.08;
    switch (e.key) {
      case 'ArrowLeft': this.camera.set({ yaw: this.camera.yaw - step }); break;
      case 'ArrowRight': this.camera.set({ yaw: this.camera.yaw + step }); break;
      case 'ArrowUp': this.camera.set({ pitch: this.camera.pitch + step }); break;
      case 'ArrowDown': this.camera.set({ pitch: this.camera.pitch - step }); break;
      case '+': case '=': this.zoomBy(0.8); return;
      case '-': case '_': this.zoomBy(1.25); return;
      default: return;
    }
    this.onChange?.();
  }

  /** Once per frame: applies flick inertia. */
  update() {
    if (this.pointers.size > 0) return;
    if (Math.abs(this.vx) + Math.abs(this.vy) < 0.05) { this.vx = this.vy = 0; return; }
    this.turn(this.vx, this.vy);
    this.vx *= 0.93;
    this.vy *= 0.93;
  }
}
