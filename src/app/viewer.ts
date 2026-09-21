/**
 * The panorama viewer: engine, tiles and controls wired together, with no UI.
 *
 * One viewer owns one canvas. It streams the clipmap around a standpoint,
 * keeps the eye on the ground (or at a given altitude), renders every frame
 * and exposes the numbers the HUD shows.
 */

import { AlignResult, DEFAULT_PROFILE, PHOTO_SKYLINE, alignPhoto, extractSkyline, horizonProfile } from '../engine/core/align';
import { Camera } from '../engine/core/camera';
import { computeVisibility } from '../engine/core/horizon';
import { LabelTarget, PlacedLabel, buildTargets, layoutLabels, pickLabel } from '../engine/core/labels';
import { Peak } from '../engine/core/peaks';
import { CoverageIndex, SurveyCredit } from '../engine/sources/coverage';
import { PeakCatalog, urlFetcher } from '../engine/sources/peakcatalog';
import { ClipmapStreamer, ClipmapConfig, DEFAULT_CLIPMAP, LOW_CLIPMAP } from '../engine/sources/clipmap';
import { TerrariumSource } from '../engine/sources/terrarium';
import { TileStore } from '../engine/sources/tilestore';
import {
  Backend, GpuRenderer, QUALITY_HIGH, QUALITY_LOW, RendererDiagnostics,
} from '../engine/render/gpu/renderer';
import { CameraFeed, DEFAULT_LENS_FOV, captureFilename, composeCapture, coverFovY, saveImage, SaveOutcome } from './cameraFeed';
import { LookControls } from './controls';
import { ExifInfo, fovFromExif, readExif } from './exif';
import { LabelPainter } from './labelPainter';
import { SensorLook } from './sensorLook';
import { AppOptions, ViewState } from './state';

const EYE_HEIGHT = 1.7;
/**
 * The eye stands EYE_HEIGHT above the highest ground this far around the
 * standpoint, not above the ground under it: a DEM post every six metres
 * rounds a slope into steps, and on a hillside an eye 1.7 m over its own
 * post is inside the next one. Flat ground is unaffected; a 45° slope lifts
 * the eye some 25 m, roughly what a viewing platform would.
 */
const EYE_CLEAR_RADIUS = 25;
/** Summits beyond this are not labelled, km. */
const LABEL_RANGE_KM = 260;
const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];

/** What the card shows about a tapped summit. */
export interface PeakInfo {
  id: string;
  name: string;
  ele?: number;
  /** Ground range, metres, and true bearing, degrees. */
  range: number;
  bearing: number;
  compass: string;
  wikipedia?: string;
  wikidata?: string;
}

/** A placed label as the tests and the console see it. */
export interface LabelBox {
  name: string; ax: number; ay: number; bx: number; by: number; bw: number; bh: number;
}

export interface ViewerStatus {
  tilesDone: number;
  tilesTotal: number;
  levelsReady: number;
  levels: number;
  /** DEM ground under the eye, metres. */
  ground: number;
  eyeAltitude: number;
  altitudeSource: 'dem' | 'given';
  fps: number;
  bytes: number;
  failed: number;
  backend: Backend;
  quality: 'high' | 'low';
  surveys: SurveyCredit[];
  diagnostics: RendererDiagnostics;
  sensors: { active: boolean; offsetYaw: number; offsetPitch: number };
  peaks: { total: number; visible: number; placed: number };
  camera: { active: boolean; fovY: number; fovSource: 'default' | 'reported' | 'manual'; width: number; height: number };
  photo: PhotoStatus | null;
}

/** A loaded photo: the frame behind the outline, and what its EXIF said. */
export interface PhotoStatus {
  width: number;
  height: number;
  /** Vertical field of view of the lens over the whole frame, degrees. */
  lensFov: number;
  lensSource: 'exif' | 'default' | 'found' | 'manual';
  /** The standpoint came from the photo's GPS. */
  positioned: boolean;
  taken?: string;
}

/** Longest side of the working copy of a photo, px. */
const PHOTO_MAX_PX = 1600;
const wrap360 = (deg: number) => deg - 360 * Math.floor(deg / 360);

export class Viewer {
  readonly camera: Camera;
  readonly renderer: GpuRenderer;
  readonly streamer: ClipmapStreamer;
  readonly controls: LookControls;
  readonly sensors: SensorLook;
  readonly source: TerrariumSource;
  readonly quality: 'high' | 'low';
  readonly catalog: PeakCatalog;
  readonly feed = new CameraFeed();
  private photo: (PhotoStatus & { pixels: Uint8ClampedArray; exif: ExifInfo }) | null = null;
  private painter: LabelPainter | null;
  private peaks: Peak[] = [];
  private targets: LabelTarget[] = [];
  private placed: PlacedLabel[] = [];
  private selected: PlacedLabel | null = null;
  private visibleCount = 0;
  private peakGeneration = 0;
  /** Labels are drawn while this is on. */
  showLabels = true;
  private coverage = new CoverageIndex();
  private surveys: SurveyCredit[] = [];
  private view: ViewState;
  private raf = 0;
  private frames = 0;
  private fpsAt = performance.now();
  private fps = 0;
  private disposed = false;

  /** Called after each frame with the current status. */
  onStatus: ((s: ViewerStatus) => void) | null = null;
  /** Called when the camera or position changed (URL sync). */
  onView: ((v: ViewState) => void) | null = null;
  /** Called when a label is tapped (or the selection cleared). */
  onSelect: ((p: PeakInfo | null) => void) | null = null;

  private constructor(
    readonly canvas: HTMLCanvasElement, renderer: GpuRenderer, opt: AppOptions, view: ViewState,
    quality: 'high' | 'low', clipmap: ClipmapConfig, overlay: HTMLCanvasElement | null,
  ) {
    this.renderer = renderer;
    this.camera = renderer.camera;
    this.quality = quality;
    this.view = view;
    this.source = new TerrariumSource({ url: opt.tiles, store: new TileStore() });
    this.streamer = new ClipmapStreamer(this.source, clipmap, view.lon, view.lat);
    this.streamer.onUpdate = () => this.onLevel();
    this.controls = new LookControls(canvas, this.camera);
    this.controls.onChange = () => this.viewChanged();
    this.controls.model.onTap = (x, y) => this.tap(x, y);
    this.sensors = new SensorLook(this.camera);
    this.catalog = new PeakCatalog(urlFetcher(opt.peaks));
    this.painter = overlay ? new LabelPainter(overlay) : null;
    this.camera.set({ yaw: view.yaw, pitch: view.pitch, fov: view.fov });
  }

  static async create(
    canvas: HTMLCanvasElement, opt: AppOptions, view: ViewState, overlay: HTMLCanvasElement | null = null,
  ): Promise<Viewer> {
    const phone = Math.min(innerWidth, innerHeight) < 600
      || (navigator.hardwareConcurrency ?? 8) <= 4;
    const quality = opt.quality === 'auto' ? (phone ? 'low' : 'high') : opt.quality;
    const renderer = await GpuRenderer.create(canvas,
      quality === 'low' ? QUALITY_LOW : QUALITY_HIGH, opt.backend);
    return new Viewer(canvas, renderer, opt, view, quality,
      quality === 'low' ? LOW_CLIPMAP : DEFAULT_CLIPMAP, overlay);
  }

  start() {
    this.renderer.setHeightField(this.streamer.heightField);
    void this.relocate(this.view);
    const loop = () => {
      if (this.disposed) return;
      this.controls.update();
      if (this.sensors.tick(performance.now())) this.viewChanged();
      if (this.feed.status.active) this.applyLensFov();
      this.renderer.render();
      this.drawLabels();
      this.frames++;
      const now = performance.now();
      if (now - this.fpsAt >= 1000) {
        this.fps = Math.round((this.frames * 1000) / (now - this.fpsAt));
        this.frames = 0;
        this.fpsAt = now;
      }
      this.onStatus?.(this.status());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  get current(): ViewState { return { ...this.view }; }

  /**
   * Follows the device's sensors; a drag then corrects the compass instead
   * of turning the view. Rejects with a readable message when refused.
   */
  async startSensors() {
    await this.sensors.start();
    this.controls.model.turnHandler = (dYaw, dPitch) => this.sensors.nudge(dYaw, dPitch);
  }

  stopSensors() {
    this.sensors.stop();
    this.controls.model.turnHandler = null;
  }

  /**
   * The camera image behind the outline: the terrain is drawn as ridge
   * lines over the washed frame, and the field of view is the lens's.
   * Rejects with a readable message when the camera is refused.
   */
  async startCamera() {
    if (this.photo) this.closePhoto();
    await this.feed.start();
    this.canvas.parentElement?.append(this.feed.video);
    this.renderer.attachVideo(this.feed.video);
    this.renderer.shaded = false;
    this.applyLensFov();
  }

  stopCamera() {
    this.feed.stop();
    this.feed.video.remove();
    this.renderer.attachVideo(null);
    this.renderer.shaded = true;
  }

  /**
   * A photo behind the outline. Its EXIF sets the standpoint (when it has
   * GPS) and the lens; the heading is whatever it is until the user drags
   * or asks for alignment.
   */
  async openPhoto(file: File): Promise<PhotoStatus> {
    if (this.feed.status.active) this.stopCamera();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const exif = readExif(bytes);
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, PHOTO_MAX_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    // Read back from a CPU-backed canvas: the pixels are for the skyline
    // extraction and the still texture, and a GPU-backed canvas turns the
    // readback into a stall of seconds on a software renderer (the same
    // lesson as the terrarium decoder).
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, w, h).data;
    const lens = fovFromExif(exif, w, h);
    const positioned = exif.lon !== undefined && exif.lat !== undefined;
    this.photo = {
      width: w, height: h, lensFov: lens ?? DEFAULT_LENS_FOV, lensSource: lens ? 'exif' : 'default',
      positioned, taken: exif.taken, pixels, exif,
    };
    this.renderer.attachStill(pixels, w, h);
    this.renderer.shaded = false;
    if (positioned) await this.relocate({ lon: exif.lon!, lat: exif.lat!, alt: undefined });
    this.applyPhotoFov();
    return this.photoStatus()!;
  }

  closePhoto() {
    if (!this.photo) return;
    this.photo = null;
    this.renderer.attachVideo(null);
    this.renderer.shaded = true;
    this.camera.set({ roll: 0 });
    this.viewChanged();
  }

  /** The lens of the photo, corrected by hand. */
  setPhotoLensFov(deg: number) {
    if (!this.photo) return;
    this.photo.lensFov = Math.max(10, Math.min(120, deg));
    this.photo.lensSource = 'manual';
    this.applyPhotoFov();
  }

  private applyPhotoFov() {
    if (!this.photo) return;
    const fov = coverFovY(this.photo.lensFov, this.photo.width, this.photo.height,
      this.canvas.clientWidth, this.canvas.clientHeight);
    this.camera.set({ fov });
    this.viewChanged();
  }

  /**
   * Lays the drawn skyline on the photo's: yaw, pitch and roll, and the lens
   * when the EXIF did not say. Applied only when the match is trusted; the
   * result says why not otherwise.
   */
  alignPhotoToTerrain(): AlignResult | null {
    const p = this.photo;
    if (!p) return null;
    const hf = this.streamer.heightField;
    const sky = extractSkyline(p.pixels, p.width, p.height, PHOTO_SKYLINE);
    const profile = horizonProfile(hf, this.renderer.eyeAltitude,
      { ...DEFAULT_PROFILE, from: this.camera.yaw - 100, span: 200 });
    const lensKnown = p.lensSource !== 'default';
    const view = {
      yaw: this.camera.yaw, pitch: this.camera.pitch, roll: this.camera.roll,
      fovY: p.lensFov, aspect: p.width / p.height,
    };
    const r = alignPhoto(sky, profile, view, lensKnown);
    if (r.ok) {
      this.camera.set({
        yaw: wrap360(view.yaw + r.dYaw), pitch: view.pitch + r.dPitch, roll: view.roll + r.dRoll,
      });
      if (!lensKnown) { p.lensFov = r.fovY; p.lensSource = 'found'; }
      this.applyPhotoFov();
    }
    return r;
  }

  private photoStatus(): PhotoStatus | null {
    const p = this.photo;
    return p ? {
      width: p.width, height: p.height, lensFov: p.lensFov, lensSource: p.lensSource,
      positioned: p.positioned, taken: p.taken,
    } : null;
  }

  /** Corrects the lens angle by hand; the view follows at once. */
  setLensFov(deg: number) {
    this.feed.setLensFov(deg);
    if (this.feed.status.active) this.applyLensFov();
  }

  private applyLensFov() {
    const fov = this.feed.renderFovY(this.canvas.clientWidth, this.canvas.clientHeight);
    if (Math.abs(fov - this.camera.fov) < 0.01) return;
    this.camera.set({ fov });
    this.viewChanged();
  }

  /** A PNG of the view with its labels, saved through the share sheet or as a download. */
  async snapshot(): Promise<SaveOutcome> {
    const gpu = await this.renderer.capture();
    if (!gpu) return 'failed';
    const stamp = `alpenrenderer · ${this.view.lat.toFixed(4)}, ${this.view.lon.toFixed(4)} · Gelände © Mapterhorn und Quellen · Gipfel © OpenStreetMap`;
    const blob = await composeCapture(gpu, this.painter?.canvas ?? null, stamp);
    if (!blob) return 'failed';
    return saveImage(blob, captureFilename(this.view.lon, this.view.lat, this.view.yaw));
  }

  /** Moves the standpoint; the clipmap refills around it. */
  async relocate(v: Partial<ViewState>) {
    this.view = { ...this.view, ...v };
    if (v.yaw !== undefined || v.pitch !== undefined || v.fov !== undefined) {
      this.camera.set({ yaw: this.view.yaw, pitch: this.view.pitch, fov: this.view.fov });
    }
    this.applyAltitude();
    this.sensors.setPosition(this.view.lon, this.view.lat);
    this.onView?.(this.current);
    void this.coverage.around(this.view.lon, this.view.lat).then((s) => { this.surveys = s; });
    this.loadPeaks();
    await this.streamer.setCenter(this.view.lon, this.view.lat);
  }

  /** The catalogue around the standpoint; a stale answer after another move is dropped. */
  private loadPeaks() {
    const gen = ++this.peakGeneration;
    const { lon, lat } = this.view;
    void this.catalog.around(lon, lat, LABEL_RANGE_KM).then((peaks) => {
      if (gen !== this.peakGeneration) return;
      this.peaks = peaks;
      this.rebuildTargets();
    });
  }

  /** Summit geometry and what the terrain hides: once per position or level, not per frame. */
  private rebuildTargets() {
    const hf = this.streamer.heightField;
    this.select(null);
    if (!this.peaks.length || !hf.levels.length) { this.targets = []; this.visibleCount = 0; return; }
    const eye = this.renderer.eyeAltitude;
    const obs = { lon: this.view.lon, lat: this.view.lat, ground: eye, eye: 0 };
    this.targets = buildTargets(this.peaks, obs, hf, Math.min(LABEL_RANGE_KM * 1000, hf.maxRange));
    this.visibleCount = computeVisibility(this.targets, hf, eye);
  }

  private drawLabels() {
    const painter = this.painter;
    if (!painter) return;
    const cssW = painter.canvas.clientWidth || 1, cssH = painter.canvas.clientHeight || 1;
    painter.resize(cssW, cssH);
    if (!this.showLabels || !this.targets.length) { this.placed = []; return; }
    this.placed = layoutLabels(this.targets, this.camera, {
      width: cssW, height: cssH, measure: painter.measure,
      lineHeight: painter.style.nameSize + 3, maxLabels: 22, detailed: 6, gap: 5,
    });
    if (this.selected) {
      const id = this.selected.target.peak.id;
      this.selected = this.placed.find((p) => p.target.peak.id === id) ?? this.selected;
    }
    painter.draw(this.placed, this.selected);
  }

  /** The labels on screen right now, in CSS pixels. */
  labels(): LabelBox[] {
    return this.placed.map((p) => ({
      name: p.target.peak.name, ax: p.ax, ay: p.ay, bx: p.bx, by: p.by, bw: p.bw, bh: p.bh,
    }));
  }

  private tap(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    this.select(pickLabel(this.placed, clientX - r.left, clientY - r.top));
  }

  select(label: PlacedLabel | null) {
    if (label === this.selected && !label) return;
    this.selected = label;
    this.onSelect?.(label ? describe(label) : null);
  }

  clearSelection() { this.select(null); }

  private onLevel() {
    this.applyAltitude();
    this.renderer.setHeightField(this.streamer.heightField);
    this.rebuildTargets();
  }

  private applyAltitude() {
    const hf = this.streamer.heightField;
    const ground = hf.groundAt(this.view.lon, this.view.lat);
    const highest = Math.max(ground, hf.summitNear(this.view.lon, this.view.lat, EYE_CLEAR_RADIUS));
    const eye = this.view.alt ?? highest + EYE_HEIGHT;
    this.renderer.moveTo(this.view.lon, this.view.lat, eye);
  }

  private viewChanged() {
    this.view = {
      ...this.view, yaw: this.camera.yaw, pitch: this.camera.pitch, fov: this.camera.fov,
    };
    this.onView?.(this.current);
  }

  status(): ViewerStatus {
    const p = this.streamer.progress;
    const hf = this.streamer.heightField;
    return {
      tilesDone: p.done, tilesTotal: p.total, levelsReady: p.levelsReady,
      levels: hf.levels.length,
      ground: hf.groundAt(this.view.lon, this.view.lat),
      eyeAltitude: this.renderer.eyeAltitude,
      altitudeSource: this.view.alt === undefined ? 'dem' : 'given',
      fps: this.fps,
      bytes: this.source.stats.bytes,
      failed: this.source.stats.failed,
      backend: this.renderer.backend,
      quality: this.quality,
      surveys: this.surveys,
      diagnostics: this.renderer.diagnostics,
      sensors: {
        active: this.sensors.active, offsetYaw: this.sensors.offsetYaw, offsetPitch: this.sensors.offsetPitch,
      },
      peaks: { total: this.peaks.length, visible: this.visibleCount, placed: this.placed.length },
      camera: {
        active: this.feed.status.active, fovY: this.feed.status.fovY, fovSource: this.feed.status.fovSource,
        width: this.feed.status.width, height: this.feed.status.height,
      },
      photo: this.photoStatus(),
    };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.feed.stop();
    this.sensors.stop();
    this.controls.dispose();
    this.streamer.cancel();
    this.renderer.dispose();
  }
}

function describe(l: PlacedLabel): PeakInfo {
  const p = l.target.peak;
  const wp = p.tags?.wikipedia;
  const m = wp ? /^([a-z\-]+):(.+)$/.exec(wp) : null;
  return {
    id: p.id,
    name: p.name,
    ele: p.ele ?? p.demEle,
    range: l.target.range,
    bearing: l.target.bearing,
    compass: COMPASS[Math.round(l.target.bearing / 45) % 8],
    wikipedia: m ? `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}` : undefined,
    wikidata: p.tags?.wikidata ? `https://www.wikidata.org/wiki/${p.tags.wikidata}` : undefined,
  };
}
