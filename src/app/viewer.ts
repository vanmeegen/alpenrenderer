/**
 * The panorama viewer: engine, tiles and controls wired together, with no UI.
 *
 * One viewer owns one canvas. It streams the clipmap around a standpoint,
 * keeps the eye on the ground (or at a given altitude), renders every frame
 * and exposes the numbers the HUD shows.
 */

import { Camera } from '../engine/core/camera';
import { CoverageIndex, SurveyCredit } from '../engine/sources/coverage';
import { ClipmapStreamer, ClipmapConfig, DEFAULT_CLIPMAP, LOW_CLIPMAP } from '../engine/sources/clipmap';
import { TerrariumSource } from '../engine/sources/terrarium';
import { TileStore } from '../engine/sources/tilestore';
import {
  Backend, GpuRenderer, QUALITY_HIGH, QUALITY_LOW, RendererDiagnostics,
} from '../engine/render/gpu/renderer';
import { LookControls } from './controls';
import { SensorLook } from './sensorLook';
import { AppOptions, ViewState } from './state';

const EYE_HEIGHT = 1.7;

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
}

export class Viewer {
  readonly camera: Camera;
  readonly renderer: GpuRenderer;
  readonly streamer: ClipmapStreamer;
  readonly controls: LookControls;
  readonly sensors: SensorLook;
  readonly source: TerrariumSource;
  readonly quality: 'high' | 'low';
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

  private constructor(
    readonly canvas: HTMLCanvasElement, renderer: GpuRenderer, opt: AppOptions, view: ViewState,
    quality: 'high' | 'low', clipmap: ClipmapConfig,
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
    this.sensors = new SensorLook(this.camera);
    this.camera.set({ yaw: view.yaw, pitch: view.pitch, fov: view.fov });
  }

  static async create(canvas: HTMLCanvasElement, opt: AppOptions, view: ViewState): Promise<Viewer> {
    const phone = Math.min(innerWidth, innerHeight) < 600
      || (navigator.hardwareConcurrency ?? 8) <= 4;
    const quality = opt.quality === 'auto' ? (phone ? 'low' : 'high') : opt.quality;
    const renderer = await GpuRenderer.create(canvas,
      quality === 'low' ? QUALITY_LOW : QUALITY_HIGH, opt.backend);
    return new Viewer(canvas, renderer, opt, view, quality,
      quality === 'low' ? LOW_CLIPMAP : DEFAULT_CLIPMAP);
  }

  start() {
    this.renderer.setHeightField(this.streamer.heightField);
    void this.relocate(this.view);
    const loop = () => {
      if (this.disposed) return;
      this.controls.update();
      if (this.sensors.tick(performance.now())) this.viewChanged();
      this.renderer.render();
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
    await this.streamer.setCenter(this.view.lon, this.view.lat);
  }

  private onLevel() {
    this.applyAltitude();
    this.renderer.setHeightField(this.streamer.heightField);
  }

  private applyAltitude() {
    const hf = this.streamer.heightField;
    const ground = hf.groundAt(this.view.lon, this.view.lat);
    const eye = this.view.alt ?? ground + EYE_HEIGHT;
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
    };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.sensors.stop();
    this.controls.dispose();
    this.streamer.cancel();
    this.renderer.dispose();
  }
}
