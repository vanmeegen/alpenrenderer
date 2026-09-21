/**
 * Rear-camera passthrough for the AR view, and the photo of it. From
 * peakviewer (MIT), with the numbers factored out so they can be tested.
 *
 * The one number that matters is the lens field of view, and no browser
 * reports it. A handful of Android builds expose a focal length; everywhere
 * else the only honest options are a sensible default and a control the
 * user nudges until the drawn skyline sits on the real one. Getting it wrong
 * does not shift the overlay, it stretches it.
 */

import type { CaptureResult } from '../engine/render/gpu/renderer';

/** Typical rear-camera vertical FOV in a 4:3 frame. A starting point, not a fact. */
export const DEFAULT_LENS_FOV = 51;

export interface FeedStatus {
  active: boolean;
  label: string | null;
  width: number;
  height: number;
  /** Vertical field of view of the lens in degrees, estimated or set by hand. */
  fovY: number;
  fovSource: 'default' | 'reported' | 'manual';
}

/**
 * Vertical FOV actually on screen when a `videoW`×`videoH` frame is drawn
 * cover-cropped into an `elemW`×`elemH` canvas: a canvas wider than the frame
 * crops top and bottom, which narrows the visible vertical angle.
 */
export function coverFovY(fovY: number, videoW: number, videoH: number, elemW: number, elemH: number): number {
  if (!videoW || !videoH || !elemW || !elemH) return fovY;
  const videoAspect = videoW / videoH;
  const elemAspect = elemW / elemH;
  if (elemAspect <= videoAspect) return fovY;
  const tanY = Math.tan((fovY * Math.PI) / 360);
  return (2 * Math.atan(tanY * (videoAspect / elemAspect)) * 180) / Math.PI;
}

export function captureFilename(lon: number, lat: number, bearing: number, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `alpen-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
    + `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
    + `-${lat.toFixed(4)}_${lon.toFixed(4)}-${Math.round(bearing)}deg.png`;
}

export class CameraFeed {
  readonly video: HTMLVideoElement;
  readonly status: FeedStatus = {
    active: false, label: null, width: 0, height: 0, fovY: DEFAULT_LENS_FOV, fovSource: 'default',
  };
  private stream: MediaStream | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.className = 'feed';
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
  }

  /** Opens the rear camera; rejects with a readable German message. */
  async start(): Promise<void> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera nicht verfügbar: kein Kamera-API in diesem Browser.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      const why = name === 'NotAllowedError' || name === 'SecurityError' ? 'Zugriff verweigert'
        : name === 'NotFoundError' ? 'keine Kamera gefunden'
          : e instanceof Error ? e.message : String(e);
      throw new Error(`Kamera nicht verfügbar: ${why}.`);
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    const track = stream.getVideoTracks()[0];
    const st = (track?.getSettings() ?? {}) as MediaTrackSettings & { focalLength?: number };
    this.status.active = true;
    this.status.label = track?.label ?? null;
    this.status.width = st.width ?? this.video.videoWidth;
    this.status.height = st.height ?? this.video.videoHeight;
    if (st.focalLength && this.status.fovSource === 'default') {
      // A few Android builds report the optics. Assume a 1/2.55" sensor, ~4.7 mm tall.
      this.status.fovY = 2 * Math.atan(4.7 / 2 / st.focalLength) * (180 / Math.PI);
      this.status.fovSource = 'reported';
    }
  }

  setLensFov(deg: number) {
    this.status.fovY = Math.max(10, Math.min(120, deg));
    this.status.fovSource = 'manual';
  }

  /** Vertical FOV to render at for a canvas of this size. */
  renderFovY(elemW: number, elemH: number): number {
    return coverFovY(this.status.fovY, this.status.width || this.video.videoWidth,
      this.status.height || this.video.videoHeight, elemW, elemH);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.status.active = false;
  }
}

/** The GPU composite plus the label overlay, with a credit line, as one PNG. */
export async function composeCapture(
  gpu: CaptureResult, overlay: HTMLCanvasElement | null, stamp?: string,
): Promise<Blob | null> {
  const cv = document.createElement('canvas');
  cv.width = gpu.width;
  cv.height = gpu.height;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const clamped = new Uint8ClampedArray(gpu.width * gpu.height * 4);
  clamped.set(gpu.pixels);
  ctx.putImageData(new ImageData(clamped, gpu.width, gpu.height), 0, 0);
  if (overlay && overlay.width > 0) ctx.drawImage(overlay, 0, 0, gpu.width, gpu.height);
  if (stamp) {
    const pad = Math.round(gpu.width * 0.018);
    ctx.font = `500 ${pad}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.fillRect(0, gpu.height - pad * 2.1, gpu.width, pad * 2.1);
    ctx.fillStyle = 'rgba(16,22,30,.85)';
    ctx.fillText(stamp, pad, gpu.height - pad * 0.5);
  }
  return new Promise((res) => cv.toBlob((b) => res(b), 'image/png'));
}

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled' | 'failed';

/**
 * The share sheet is the only route a web page has into the Photos app; where
 * files cannot be shared the image is downloaded instead.
 */
export async function saveImage(blob: Blob, filename: string): Promise<SaveOutcome> {
  const file = new File([blob], filename, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean; share?: (d: ShareData) => Promise<void> };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
