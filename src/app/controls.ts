/**
 * DOM adapter for the gesture model: pointer, wheel and key events on the
 * canvas go to a GestureModel, which owns every decision about what they mean.
 */

import { Camera } from '../engine/core/camera';
import { GestureModel } from './gestures';

export class LookControls {
  readonly model: GestureModel;
  private detach: (() => void)[] = [];

  constructor(readonly el: HTMLElement, camera: Camera) {
    this.model = new GestureModel(camera, () => ({ width: el.clientWidth, height: el.clientHeight }));
    const on = <K extends keyof HTMLElementEventMap>(
      type: K, fn: (e: HTMLElementEventMap[K]) => void, opt?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn, opt);
      this.detach.push(() => el.removeEventListener(type, fn, opt));
    };
    on('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      this.model.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
    }, { passive: false });
    on('pointermove', (e) => {
      e.preventDefault();
      this.model.move(e.pointerId, e.clientX, e.clientY, e.timeStamp);
    }, { passive: false });
    on('pointerup', (e) => this.model.up(e.pointerId, e.timeStamp));
    on('pointercancel', (e) => this.model.up(e.pointerId, e.timeStamp));
    on('wheel', (e) => { e.preventDefault(); this.model.wheel(e.deltaY); }, { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    const key = (e: KeyboardEvent) => { if (this.model.key(e.key)) e.preventDefault(); };
    window.addEventListener('keydown', key);
    this.detach.push(() => window.removeEventListener('keydown', key));
  }

  set onChange(fn: (() => void) | null) { this.model.onChange = fn; }

  /** Once per frame. */
  update(now = performance.now()) { this.model.tick(now); }

  dispose() { for (const d of this.detach) d(); }
}
