/**
 * When a frame is worth drawing.
 *
 * The render loop ticks every animation frame, but a view nobody moved, with
 * no level landing and no video behind it, looks exactly like the last frame.
 * Drawing it again costs the battery on a phone and, under a software
 * rasterizer, a whole core per page. The renderer fingerprints every input a
 * frame depends on and asks the gate; the gate says yes when the fingerprint
 * changed, for the first frames (the pipelines compile and the atlas lands
 * over them), as often as requested, and always behind a live source.
 */

export interface FrameInputs {
  camera: { yaw: number; pitch: number; roll: number; fov: number };
  /** Canvas size in CSS pixels and the hardware scaling in force. */
  size: { w: number; h: number; scale: number };
  eye: number;
  origin: [number, number];
  /** Per clipmap level: what changes the atlas or the window's place. */
  levels: { version: number; waterVersion?: number; filled: boolean; px0: number; py0: number }[];
  /** Everything else the shaders read: flags, sliders, colours, the telescope band. */
  knobs: Record<string, number | boolean | string | null | readonly number[]>;
}

/** A string that changes when, and only when, some input changes. */
export function frameFingerprint(i: FrameInputs): string {
  const c = i.camera, s = i.size;
  const levels = i.levels.map((l) => `${l.version}.${l.waterVersion ?? 0}.${l.filled ? 1 : 0}.${l.px0}.${l.py0}`).join(',');
  const knobs = Object.keys(i.knobs).sort().map((k) => {
    const v = i.knobs[k];
    return `${k}=${v === null ? 'null' : Array.isArray(v) ? (v as readonly number[]).join(':') : String(v)}`;
  }).join(';');
  return `${c.yaw},${c.pitch},${c.roll},${c.fov}|${s.w},${s.h},${s.scale}|${i.eye}|${i.origin[0]},${i.origin[1]}|${levels}|${knobs}`;
}

export class RedrawGate {
  private last: string | null = null;
  private drawn = 0;
  private forced = 0;

  /** `warmup`: how many frames are drawn regardless at the start. */
  constructor(private readonly warmup = 3) {}

  /** Draw the next `n` frames whatever the inputs: a context restored, a texture replaced. */
  request(n = 1) { this.forced = Math.max(this.forced, n); }

  /** Whether to draw now; `live` for a source that changes every frame (the camera image). */
  need(fingerprint: string, live: boolean): boolean {
    const yes = live || this.drawn < this.warmup || this.forced > 0 || fingerprint !== this.last;
    if (!yes) return false;
    this.last = fingerprint;
    this.drawn++;
    if (this.forced > 0) this.forced--;
    return true;
  }
}
