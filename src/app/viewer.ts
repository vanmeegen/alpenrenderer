/**
 * The panorama viewer: engine, tiles and controls wired together, with no UI.
 *
 * One viewer owns one canvas. It streams the clipmap around a standpoint,
 * keeps the eye on the ground (or at a given altitude), renders every frame
 * and exposes the numbers the HUD shows.
 */

import { AlignResult, DEFAULT_PROFILE, PHOTO_SKYLINE, alignPhoto, extractSkyline, horizonProfile } from '../engine/core/align';
import { Camera, fovForAspect, longFovOf } from '../engine/core/camera';
import { DEFAULT_HORIZON, HorizonTable, VisibilityJob } from '../engine/core/horizon';
import { LabelTarget, PlacedLabel, buildTargets, layout, pickLabel } from '../engine/core/labels';
import { pointerSpot, pointerTo, searchTargets } from '../engine/core/find';
import { Fix, summitUnder } from '../engine/core/stand';
import { Peak } from '../engine/core/peaks';
import { CoverageIndex, SurveyCredit } from '../engine/sources/coverage';
import { PeakCatalog, urlFetcher } from '../engine/sources/peakcatalog';
import { LakeCatalog, lakeFetcher } from '../engine/sources/lakecatalog';
import { LandCover, urlCoverLoader } from '../engine/sources/landcover';
import { Imagery, urlImageryLoader } from '../engine/sources/imagery';
import { Lake, lakeLabel, rasterizeLakes } from '../engine/core/water';
import { bandFor, lookRange, meshTopNear } from '../engine/render/mesh';
import { DEG, destination, localRadius } from '../engine/core/geodesy';
import { ClipmapStreamer } from '../engine/sources/clipmap';
import { TerrariumSource } from '../engine/sources/terrarium';
import { TileStore } from '../engine/sources/tilestore';
import { Backend, GpuRenderer, RendererDiagnostics } from '../engine/render/gpu/renderer';
import { Profile, Tier, deviceTier, profileFor, thisDevice } from './device';
import { CameraFeed, DEFAULT_LENS_FOV, captureFilename, composeCapture, coverFovY, saveImage, SaveOutcome } from './cameraFeed';
import { LookControls } from './controls';
import { ExifInfo, fovFromExif, readExif } from './exif';
import { LabelPainter } from './labelPainter';
import { SensorLook } from './sensorLook';
import { AppOptions, Style, ViewState, readStyle, writeStyle, clampEyeHeight, clampOutline, readEyeHeight, readOutline, writeEyeHeight, writeOutline } from './state';
import { CLEAR_VIEW, clearView, fitRadius } from '../engine/core/eye';
import { Adaptation } from '../engine/render/adapt';
import { OUTLINE } from '../engine/render/outline';

/** Milliseconds without a change of the view after which it counts as resting (longer than adapt.ts takes for a pause). */
const REST_MS = 300;

/** Milliseconds of sightline work per frame; the rest of the frame stays for drawing and touch. */
const VISIBILITY_BUDGET_MS = 4;
/** Quiet time after a level arrives before the label targets are rebuilt. */
const REBUILD_SETTLE_MS = 300;
/** Summits beyond this are not labelled, km. */
const LABEL_RANGE_KM = 260;
/**
 * Lakes are loaded this far out: beyond it even Lake Geneva is a sliver on
 * the horizon, and the coarse outer levels could not draw it anyway.
 */
const LAKE_RANGE_KM = 120;
const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];

/** What the card shows about a tapped summit. */
export interface PeakInfo {
  id: string;
  name: string;
  ele?: number;
  /** A summit or a lake (the card says "See" for a lake). */
  kind: 'peak' | 'lake';
  /** Sought by name and not in sight from here (the card says so). */
  hidden?: boolean;
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
  /** Levels that hold the window for this standpoint. */
  levelsReady: number;
  levels: number;
  /** Levels that hold terrain at all: after a short move the old windows still do while the new ones load. */
  levelsShown: number;
  /** Tiles still on their way. */
  pending: number;
  /** Tiles that did not arrive, retries included; their levels are left out until retryTiles(). */
  missing: number;
  /** Levels the tile source has no data for at this place. */
  levelsEmpty: number;
  /** Levels that hold a land cover class per post (sources/landcover.ts). */
  levelsCovered: number;
  /** Levels that hold an aerial picture (sources/imagery.ts); 0 outside the aerial style. */
  levelsPictured: number;
  /** DEM ground under the eye, metres. */
  ground: number;
  eyeAltitude: number;
  /** Metres the eye is lifted over what stands right around the standpoint (the clear view); 0 when nothing does. */
  eyeLift: number;
  altitudeSource: 'dem' | 'given';
  fps: number;
  bytes: number;
  failed: number;
  /** What the tile decoder probe found: "exakt (bitmap)" or why not. */
  decoder: string;
  backend: Backend;
  quality: 'high' | 'mid' | 'low';
  /** The device class the settings were chosen for. */
  tier: Tier;
  /** The adaptation to slow frames: whether it runs, how much coarser the moving frame is drawn, whether the haze rim is on. */
  adaptation: { on: boolean; scale: number; rim: boolean };
  surveys: SurveyCredit[];
  diagnostics: RendererDiagnostics;
  sensors: { active: boolean; offsetYaw: number; offsetPitch: number };
  /**
   * `settled`: the targets are from the last rebuild (none pending) and all
   * their sightlines are decided, so the labels stand where they will stay.
   */
  peaks: { total: number; visible: number; placed: number; unnamed: number; settled: boolean; layouts: number };
  /** The summit being sought (seek): whether it is in sight and in the frame, and how far to turn for it, degrees. */
  sought: { id: string; name: string; visible: boolean; inFrame: boolean; turn: number } | null;
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
  readonly quality: 'high' | 'mid' | 'low';
  readonly catalog: PeakCatalog;
  readonly lakeCatalog: LakeCatalog;
  readonly feed = new CameraFeed();
  private photo: (PhotoStatus & { pixels: Uint8ClampedArray; exif: ExifInfo }) | null = null;
  private painter: LabelPainter | null;
  private peaks: Peak[] = [];
  private lakes: Lake[] = [];
  private lakeLabels: Peak[] = [];
  private lakeGeneration = 0;
  /** Bumped when the lake list changes, so every level's mask is redrawn. */
  private lakesVersion = 0;
  /** Per level: what its current water mask was drawn from. */
  private waterStamp = new WeakMap<object, string>();
  private landCover: LandCover;
  private coverStamp = new WeakMap<object, string>();
  private imagery: Imagery;
  private imageryStamp = new WeakMap<object, string>();
  private targets: LabelTarget[] = [];
  /** Counts every new set of targets, the empty one after a move included. */
  private targetsVersion = 0;
  private visibility: VisibilityJob | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private placed: PlacedLabel[] = [];
  private selected: PlacedLabel | null = null;
  /** The summit or lake being sought (the find panel), by id: it survives a rebuild of the targets. */
  private soughtId: string | null = null;
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
    readonly profile: Profile, overlay: HTMLCanvasElement | null,
  ) {
    this.renderer = renderer;
    renderer.outline = readOutline();
    // The lit shade pass when the style is the relief and the URL does not
    // switch it off (state.ts AppOptions.shade); the camera and photo modes
    // switch it off while they run and restore this.
    this.shadeAllowed = opt.shade;
    this.style = readStyle();
    this.shadeView = opt.shade && this.style !== 'lines';
    renderer.shaded = this.shadeView;
    renderer.aerial = this.style === 'aerial';
    this.camera = renderer.camera;
    this.quality = profile.quality;
    this.view = view;
    this.source = new TerrariumSource({ url: opt.tiles, store: new TileStore() });
    this.source.decoded.limit = profile.tiles;
    this.adaptation = new Adaptation(opt.adapt ?? profile.adapt);
    this.streamer = new ClipmapStreamer(this.source, profile.clipmap, view.lon, view.lat);
    this.streamer.onUpdate = () => this.onLevel();
    this.controls = new LookControls(canvas, this.camera);
    this.controls.onChange = () => this.viewChanged();
    this.controls.model.onTap = (x, y) => this.tap(x, y);
    this.sensors = new SensorLook(this.camera);
    this.catalog = new PeakCatalog(urlFetcher(opt.peaks));
    this.lakeCatalog = new LakeCatalog(lakeFetcher(opt.lakes));
    this.landCover = new LandCover(urlCoverLoader(opt.cover));
    this.imagery = new Imagery(urlImageryLoader(opt.imagery));
    this.painter = overlay ? new LabelPainter(overlay) : null;
    this.camera.set({ yaw: view.yaw, pitch: view.pitch, fov: view.fov });
  }

  static async create(
    canvas: HTMLCanvasElement, opt: AppOptions, view: ViewState, overlay: HTMLCanvasElement | null = null,
  ): Promise<Viewer> {
    const profile = profileFor(deviceTier(thisDevice()), opt.quality);
    const renderer = await GpuRenderer.create(canvas, profile.mesh, opt.backend);
    renderer.maxPixelRatio = profile.pixelRatio;
    return new Viewer(canvas, renderer, opt, view, profile, overlay);
  }

  start() {
    this.renderer.setHeightField(this.streamer.heightField);
    void this.relocate(this.view);
    this.watchOrientation();
    const loop = () => {
      if (this.disposed) return;
      this.controls.update();
      if (this.sensors.tick(performance.now())) this.viewChanged();
      this.keepLongFov();
      this.aimTelescope();
      if (this.feed.status.active) this.applyLensFov();
      if (this.visibility && !this.visibility.done) {
        this.visibility.step(VISIBILITY_BUDGET_MS);
        this.visibleCount = this.visibility.visible;
      }
      // Drawn only when something changed (renderer gate); the fps counts drawn frames.
      const now = performance.now();
      // A view that has rested a moment is drawn at every pixel; one that
      // moves, as coarse as its frame times ask for (render/adapt.ts).
      this.renderer.resolutionScale = now - this.movedAt < REST_MS ? this.adaptation.scale : 1;
      this.renderer.rim = this.adaptation.rim ? OUTLINE.rim : 0;
      this.renderer.detail = this.adaptation.rim ? 1 : 0;
      if (this.renderer.render()) {
        this.frames++;
        if (this.drawnAt) this.adaptation.frame(now - this.drawnAt, now);
        this.drawnAt = now;
      }
      this.drawLabels();
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
    this.renderer.shaded = this.shadeView;
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
    if (positioned) {
      this.fixAccuracy = null;
      await this.relocate({ lon: exif.lon!, lat: exif.lat!, alt: undefined });
    }
    this.applyPhotoFov();
    return this.photoStatus()!;
  }

  closePhoto() {
    if (!this.photo) return;
    this.photo = null;
    this.renderer.attachVideo(null);
    this.renderer.shaded = this.shadeView;
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

  /** Whether the view is drawn lit when no camera image or photo is behind it (AppOptions.shade). */
  private shadeView: boolean;
  private readonly shadeAllowed: boolean;
  /** How the terrain is drawn (state.ts Style); kept on the device. */
  style: Style;

  setStyle(style: Style) {
    this.style = style;
    writeStyle(style);
    this.shadeView = this.shadeAllowed && style !== 'lines';
    if (!this.feed.status.active && !this.photo) this.renderer.shaded = this.shadeView;
    this.renderer.aerial = style === 'aerial';
    this.applyImagery();
  }

  private lastAspect = 0;

  /** Zoomed in below this field of view, the rings crowd around the distance looked at (mesh.ts bandFor). */
  static readonly TELESCOPE_FOV = 30;

  /**
   * The telescope: zoomed in, a dense band of rings around where the centre
   * of the view meets the ground, so the summit looked at is drawn with
   * rings a post apart instead of 1/190 of its range. Quantised in bandFor,
   * so panning across a slope leaves the rings where they are.
   */
  private aimTelescope() {
    const hf = this.streamer.heightField;
    const zoomed = this.camera.fov < Viewer.TELESCOPE_FOV && hf.levels.length > 0;
    const r = zoomed ? lookRange(hf, this.renderer.eyeAltitude, this.camera.yaw, this.camera.pitch) : null;
    const band = bandFor(r, this.camera.fov);
    const cur = this.renderer.band;
    if ((band?.r1 ?? -1) !== (cur?.r1 ?? -1) || (band?.r2 ?? -1) !== (cur?.r2 ?? -1)) this.renderer.band = band;
    // The fine data windows (clipmap.ts look levels) go to the same point; one fetch at a time.
    if (r !== null) {
      if (!this.looking) {
        const at = destination(hf.lon, hf.lat, this.camera.yaw, r, localRadius(hf.lat));
        this.looking = this.streamer.setLook(at.lon, at.lat).finally(() => { this.looking = null; });
      }
    } else if (!zoomed) {
      this.streamer.clearLook();
    }
  }

  private looking: Promise<void> | null = null;

  /** Set by the browser's orientation change; the next frame whose aspect has flipped converts the field of view. */
  private flipPending = false;

  /**
   * A phone turned over keeps the angle along its long side: 60° across the
   * sideways screen becomes 60° up the upright one, the same magnification
   * either way. Only on the browser's orientation change, once the canvas
   * has followed it: the canvas passes through odd sizes while the page lays
   * itself out, and those are not rotations (a 1000×600 view read 38° for a
   * moment of 1×600). The camera's own lens angle is applyLensFov's.
   */
  private keepLongFov() {
    const a = this.camera.aspect;
    if (!a) return;
    if (this.flipPending && this.lastAspect && (a > 1) !== (this.lastAspect > 1)) {
      this.flipPending = false;
      if (!this.feed.status.active && !this.photo) {
        this.camera.set({ fov: fovForAspect(longFovOf(this.camera.fov, this.lastAspect), a) });
        this.viewChanged();
      }
    }
    if (!this.flipPending) this.lastAspect = a;
  }

  private watchOrientation() {
    try {
      window.matchMedia?.('(orientation: portrait)')?.addEventListener?.('change', () => { this.flipPending = true; });
    } catch { /* no media queries here */ }
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

  /** The answer to slow frames: fewer pixels while the view moves (render/adapt.ts). */
  readonly adaptation: Adaptation;
  /** When the view last changed, and when the last frame was drawn (performance.now). */
  private movedAt = -Infinity;
  private drawnAt = 0;

  /** The view changed just now: the frames that follow are moving frames. */
  private moving() {
    this.movedAt = performance.now();
    this.renderer.resolutionScale = this.adaptation.scale;
  }

  /** Where the catalogues and the label targets were last asked for; null before the first standpoint. */
  private standAt: { lon: number; lat: number } | null = null;

  /**
   * Changes the view; with another lon/lat the standpoint moves and the
   * clipmap refills around it. The label targets hold bearings and ranges
   * from the standpoint, so a move drops them at once, with their sightlines
   * and what is placed: nothing of the old place is drawn from the new one.
   */
  async relocate(v: Partial<ViewState>) {
    const before = this.view.alt;
    this.view = { ...this.view, ...v };
    const moved = !this.standAt || this.standAt.lon !== this.view.lon || this.standAt.lat !== this.view.lat;
    if (v.yaw !== undefined || v.pitch !== undefined || v.fov !== undefined) {
      this.camera.set({ yaw: this.view.yaw, pitch: this.view.pitch, fov: this.view.fov });
      this.moving();
    }
    this.applyAltitude();
    if (moved) {
      this.standAt = { lon: this.view.lon, lat: this.view.lat };
      this.select(null);
      this.targets = [];
      this.targetsVersion++;
      this.visibility = null;
      this.visibleCount = 0;
      this.placed = [];
      this.sensors.setPosition(this.view.lon, this.view.lat);
      void this.coverage.around(this.view.lon, this.view.lat).then((s) => { this.surveys = s; });
      this.loadPeaks();
      this.loadLakes();
    } else if (this.view.alt !== before) {
      this.scheduleRebuildTargets();                        // the same place, seen from another height
    }
    this.onView?.(this.current);
    await this.streamer.setCenter(this.view.lon, this.view.lat);
  }

  /** Asks again for the tiles that did not arrive (status().missing). */
  retryTiles(): Promise<void> {
    return this.streamer.retry();
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

  /** Lakes around the standpoint: water on the terrain and names among the labels. */
  private loadLakes() {
    const gen = ++this.lakeGeneration;
    const { lon, lat } = this.view;
    void this.lakeCatalog.around(lon, lat, LAKE_RANGE_KM).then((lakes) => {
      if (gen !== this.lakeGeneration) return;
      this.lakes = lakes;
      this.lakeLabels = lakes.map(lakeLabel);
      this.lakesVersion++;
      this.applyWater();
      this.renderer.setHeightField(this.streamer.heightField);
      this.rebuildTargets();
    });
  }

  /**
   * Burns the lakes into every filled level whose grid or data changed since
   * its mask was drawn (a refill, a recentre, a new lake list).
   */
  private applyWater() {
    for (const l of this.streamer.heightField.levels) {
      if (!l.filled) continue;
      const stamp = `${l.version}|${l.px0},${l.py0}|${this.lakesVersion}`;
      if (this.waterStamp.get(l) === stamp) continue;
      this.waterStamp.set(l, stamp);
      l.water = this.lakes.length ? rasterizeLakes(l, this.lakes) : undefined;
      l.waterVersion = (l.waterVersion ?? 0) + 1;
    }
  }

  /**
   * Reads the land cover onto every filled level around the observer whose
   * grid or data changed since (sources/landcover.ts). The tiles come over
   * the network: until they are in, a level that moved is drawn without a
   * class rather than with the classes of where it was.
   */
  private applyCover() {
    const hf = this.streamer.heightField;
    for (const l of hf.levels) {
      if (!l.filled || l.role === 'look') continue;
      const stamp = `${l.version}|${l.px0},${l.py0}`;
      if (this.coverStamp.get(l) === stamp) continue;
      this.coverStamp.set(l, stamp);
      if (l.cover) { l.cover = undefined; l.coverVersion = (l.coverVersion ?? 0) + 1; }
      void this.landCover.rasterize(l).then((classes) => {
        if (this.disposed || !classes || this.coverStamp.get(l) !== stamp) return;
        l.cover = classes;
        l.coverVersion = (l.coverVersion ?? 0) + 1;
        this.renderer.setHeightField(hf);
      });
    }
  }

  /**
   * In the aerial style: reads the satellite picture onto every filled
   * level around the observer whose grid changed since. The tiles come
   * from a rate-limited server and may not come: a level without a picture
   * is drawn as relief, which is also what shows until the picture is in.
   */
  private applyImagery() {
    if (this.style !== 'aerial' || !this.shadeAllowed) return;
    const hf = this.streamer.heightField;
    for (const l of hf.levels) {
      if (!l.filled || l.role === 'look') continue;
      const stamp = `${l.version}|${l.px0},${l.py0}`;
      if (this.imageryStamp.get(l) === stamp) continue;
      this.imageryStamp.set(l, stamp);
      if (l.imagery) { l.imagery = undefined; l.imageryVersion = (l.imageryVersion ?? 0) + 1; }
      void this.imagery.rasterize(l).then((picture) => {
        if (this.disposed || !picture || this.imageryStamp.get(l) !== stamp) return;
        l.imagery = picture;
        l.imageryVersion = (l.imageryVersion ?? 0) + 1;
        this.renderer.setHeightField(hf);
      });
    }
  }

  /** Summit geometry and what the terrain hides: once per position or level, not per frame. */
  private rebuildTargets() {
    const hf = this.streamer.heightField;
    // The selection survives a rebuild: drawLabels re-binds it to the same
    // summit by id. Only a new standpoint (relocate) clears it.
    const named = this.lakeLabels.length ? [...this.peaks, ...this.lakeLabels] : this.peaks;
    this.targetsVersion++;
    if (!named.length || !hf.levels.length) { this.targets = []; this.visibility = null; this.visibleCount = 0; return; }
    const eye = this.renderer.eyeAltitude;
    const obs = { lon: this.view.lon, lat: this.view.lat, ground: eye, eye: 0 };
    // Label pins go onto the summits as the mesh draws them, not the DEM's
    // sharper ones; the mesh follows the view, so its layout is read when asked.
    const before = this.targets;
    this.targets = buildTargets(named, obs, hf, Math.min(LABEL_RANGE_KM * 1000, hf.maxRange),
      (lon, lat) => {
        const mesh = this.renderer.meshParams();
        return mesh ? meshTopNear(hf, mesh, lon, lat, eye) : { lon, lat, h: hf.height(lon, lat) };
      });
    // Sightlines over frames, not in one go: see VisibilityJob. What was seen
    // from here before stays seen until it is decided anew.
    this.visibility = new VisibilityJob(this.targets, hf, eye, DEFAULT_HORIZON, undefined, before);
    this.visibleCount = this.visibility.visible;
  }

  /**
   * Levels arrive in a burst while the terrain loads; rebuilding the targets
   * for each would restart the sightlines eight times. Once per burst is
   * enough, a few hundred milliseconds after the last level.
   */
  private scheduleRebuildTargets() {
    if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => { this.rebuildTimer = null; this.rebuildTargets(); }, REBUILD_SETTLE_MS);
  }

  /** What the labels were last laid out for, and how often they have been (status().peaks.layouts). */
  private labelStamp = '';
  private layouts = 0;
  /** Visible summits and lakes in the frame that went without a name in the last layout. */
  private unnamed = 0;
  /** What stands on the screen over the picture, CSS pixels from the overlay's corner (labels.ts LayoutOptions.blocked). */
  private blocked: { x: number; y: number; w: number; h: number }[] = [];
  private blockedKey = '';

  /** The app says where its menu, panels and compass are: no label goes under them. */
  setBlocked(rects: { x: number; y: number; w: number; h: number }[]) {
    const key = rects.map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`).join(';');
    if (key === this.blockedKey) return;
    this.blockedKey = key;
    this.blocked = rects;
  }

  /**
   * Lays the labels out and paints them, when something they depend on
   * changed: the view, the overlay's size, the targets, how many of them are
   * decided, the mesh the pins sit on, the selection. A still view costs
   * nothing; it used to cost a layout of every visible summit and a repaint
   * of the overlay per animation frame.
   */
  private drawLabels() {
    const painter = this.painter;
    if (!painter) return;
    const cssW = painter.canvas.clientWidth || 1, cssH = painter.canvas.clientHeight || 1;
    const mesh = this.renderer.meshParams();
    const drawnKey = mesh ? `${mesh.az0.toFixed(9)}:${mesh.azStep.toFixed(12)}:${mesh.rNearEnd.toFixed(3)}:${mesh.rSplit.toFixed(3)}` : undefined;
    const c = this.camera;
    const stamp = [
      cssW, cssH, globalThis.devicePixelRatio ?? 1, this.showLabels, this.targetsVersion, this.visibility?.decided ?? -1,
      c.yaw, c.pitch, c.roll, c.fov, c.aspect, drawnKey ?? '', this.selected?.target.peak.id ?? '', this.blockedKey,
      this.soughtId ?? '',
    ].join('|');
    if (stamp === this.labelStamp) return;
    this.labelStamp = stamp;
    this.layouts++;
    painter.resize(cssW, cssH);
    if (!this.showLabels || !this.targets.length) { this.placed = []; this.unnamed = 0; return; }   // resize() cleared the overlay
    const laid = layout(this.targets, this.camera, {
      width: cssW, height: cssH, measure: painter.measure,
      lineHeight: painter.style.nameSize + 3, maxLabels: 60, detailed: 6, gap: 5,
      drawnKey, blocked: this.blocked, previous: this.placed,
    });
    this.placed = laid.placed;
    this.unnamed = laid.inFrame - laid.placed.length;
    if (this.selected) {
      const id = this.selected.target.peak.id;
      this.selected = this.placed.find((p) => p.target.peak.id === id) ?? this.selected;
    }
    painter.draw(this.placed, this.selected);
    this.drawSought(painter, cssW, cssH);
  }

  /** The main spot of the summit being sought, if it is within range from here. */
  private soughtTarget(): LabelTarget | null {
    const id = this.soughtId;
    return id ? this.targets.find((t) => t.peak.id === id && t.spot === 0) ?? null : null;
  }

  private pointer(t: LabelTarget) {
    const c = this.camera;
    return pointerTo({ yaw: c.yaw, pitch: c.pitch, fov: c.fov, aspect: c.aspect }, t);
  }

  /**
   * The summit being sought: an arrow toward it while it is out of the
   * frame; in the frame, a ring where it stands unless it has a label there
   * (then the label is the selected one).
   */
  private drawSought(painter: LabelPainter, cssW: number, cssH: number) {
    const t = this.soughtTarget();
    if (!t) return;
    const p = this.pointer(t);
    if (p) {
      const at = pointerSpot(p, cssW, cssH);
      const turn = Math.round(Math.abs(p.turn));
      const way = turn < 3 ? (p.lift > 0 ? 'oben' : 'unten') : `${turn}° ${p.turn < 0 ? 'links' : 'rechts'}`;
      painter.drawPointer(at.x, at.y, p.dx, p.dy, `${t.peak.name} · ${way}`);
      return;
    }
    if (this.placed.some((l) => l.target.peak.id === t.peak.id)) return;
    const ndc = new Float32Array(3);
    if (this.camera.project(t.east, t.north, t.up, ndc) <= 0) return;
    painter.drawMark((ndc[0] * 0.5 + 0.5) * cssW, (0.5 - ndc[1] * 0.5) * cssH, t.decided && !t.visible ? `${t.peak.name} (verdeckt)` : t.peak.name);
  }

  /**
   * The catalogued summit a device fix stands on, within what the fix is
   * good for (core/stand.ts), or null: asked before the standpoint is put
   * there, so the catalogue is read for the fix's place, not the current one.
   */
  async summitUnder(fix: Fix): Promise<{ name: string; lon: number; lat: number } | null> {
    const s = summitUnder(fix, await this.catalog.around(fix.lon, fix.lat, 1));
    return s ? { name: s.peak.name, lon: s.peak.lon, lat: s.peak.lat } : null;
  }

  /** Summits and lakes for the find panel: what is in sight, or everything within range whose name holds the query. */
  find(query: string): FoundPeak[] {
    return searchTargets(this.targets, query).map((f) => ({ ...describeTarget(f.target), visible: f.visible, decided: f.decided }));
  }

  /**
   * Seeks a summit by id (from find): it is marked in the picture, pointed
   * at when out of the frame, and described on the card. The view turns to
   * it unless the device's sensors are steering. Null ends the search.
   */
  seek(id: string | null) {
    this.soughtId = id;
    const t = this.soughtTarget();
    if (!t) { this.soughtId = null; this.select(null); return; }
    if (!this.sensors.active) {
      this.camera.set({ yaw: t.bearing, pitch: Math.max(-80, Math.min(80, t.elevation)) });
      this.viewChanged();
    }
    this.selected = this.placed.find((l) => l.target.peak.id === id) ?? null;
    this.onSelect?.({ ...describeTarget(t), ...(t.decided && !t.visible ? { hidden: true } : {}) });
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
    if (label === this.selected && !label && !this.soughtId) return;
    // A tap elsewhere, or the card closed: whatever was sought is no longer.
    if (!label || label.target.peak.id !== this.soughtId) this.soughtId = null;
    this.selected = label;
    this.onSelect?.(label ? describe(label) : null);
  }

  clearSelection() { this.select(null); }

  private onLevel() {
    this.applyAltitude();
    this.applyWater();
    this.applyCover();
    this.applyImagery();
    this.renderer.setHeightField(this.streamer.heightField);
    this.scheduleRebuildTargets();
  }

  /**
   * How far above the ground under the standpoint the eye stands (state.ts
   * EYE_HEIGHT): 1.7 m by default, more on the slider to look over the woods.
   * The ground is the DEM's bilinear surface, the same the mesh draws, so
   * the eye is never inside the terrain.
   */
  eyeHeight = readEyeHeight();

  setEyeHeight(m: number) {
    this.eyeHeight = clampEyeHeight(m);
    writeEyeHeight(this.eyeHeight);
    this.applyAltitude();
    this.scheduleRebuildTargets();
  }

  /** How strongly the ridge lines are drawn, 0..1 ("Konturen"); kept on the device. */
  get outline(): number { return this.renderer.outline; }

  setOutline(v: number) {
    this.renderer.outline = clampOutline(v);
    writeOutline(this.renderer.outline);
  }

  /** Accuracy of the fix the standpoint came from, metres; null when it was chosen (map, place, URL). */
  fixAccuracy: number | null = null;
  /** How far the eye is lifted over what stands right around the standpoint, metres (core/eye.ts). */
  private eyeLift = 0;

  /**
   * Puts the eye where it belongs: at the altitude the URL gives, or over
   * the ground at the standpoint by the eye height, and by more where
   * something right around the standpoint would otherwise be the whole view
   * (the clear view, core/eye.ts). An eye height set above that already
   * looks over it.
   */
  private applyAltitude() {
    const hf = this.streamer.heightField;
    const { lon, lat } = this.view;
    const ground = hf.groundAt(lon, lat);
    this.eyeLift = 0;
    if (this.view.alt === undefined && hf.resAt(0) > 0) {
      const mLat = 111320, mLon = 111320 * Math.cos(lat * DEG);
      const radius = fitRadius(this.fixAccuracy), eye = ground + this.eyeHeight;
      // The horizon beyond the disc, from the eye as it stands: the same table the labels are held against, begun there.
      const beyond = new HorizonTable(hf, eye, { ...DEFAULT_HORIZON, bearings: CLEAR_VIEW.bearings, start: radius });
      this.eyeLift = clearView(
        (e, n) => hf.height(lon + e / mLon, lat + n / mLat, Math.hypot(e, n)),
        (bearing) => beyond.skyline(bearing),
        eye, radius, Math.max(2, hf.resAt(0) / 2),
      ).lift;
    }
    const eye = this.view.alt ?? ground + this.eyeHeight + this.eyeLift;
    this.renderer.moveTo(lon, lat, eye);
  }

  private viewChanged() {
    this.moving();
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
      levels: hf.eyeLevels().length,
      levelsShown: hf.eyeLevels().filter((l) => l.filled).length,
      pending: p.pending, missing: p.failed, levelsEmpty: p.empty,
      levelsCovered: this.streamer.heightField.levels.filter((l) => l.cover).length,
      levelsPictured: this.streamer.heightField.levels.filter((l) => l.imagery).length,
      ground: hf.groundAt(this.view.lon, this.view.lat),
      eyeAltitude: this.renderer.eyeAltitude,
      eyeLift: this.eyeLift,
      altitudeSource: this.view.alt === undefined ? 'dem' : 'given',
      fps: this.fps,
      bytes: this.source.stats.bytes,
      failed: this.source.stats.failed,
      decoder: this.source.decoderReport,
      backend: this.renderer.backend,
      quality: this.quality,
      tier: this.profile.tier,
      adaptation: { on: this.adaptation.enabled, scale: this.adaptation.scale, rim: this.adaptation.rim },
      surveys: this.surveys,
      diagnostics: this.renderer.diagnostics,
      sensors: {
        active: this.sensors.active, offsetYaw: this.sensors.offsetYaw, offsetPitch: this.sensors.offsetPitch,
      },
      peaks: {
        total: this.peaks.length, visible: this.visibleCount, placed: this.placed.length, unnamed: this.unnamed, layouts: this.layouts,
        settled: this.rebuildTimer === null && (this.visibility?.done ?? false),
      },
      sought: (() => {
        const t = this.soughtTarget();
        if (!t) return null;
        const p = this.pointer(t);
        return { id: t.peak.id, name: t.peak.name, visible: t.decided && t.visible, inFrame: !p, turn: p ? p.turn : 0 };
      })(),
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
    if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
    this.feed.stop();
    this.sensors.stop();
    this.controls.dispose();
    this.streamer.cancel();
    this.renderer.dispose();
  }
}

/** A found summit or lake as the find panel lists it. */
export interface FoundPeak extends PeakInfo {
  visible: boolean;
  decided: boolean;
}

const describe = (l: PlacedLabel): PeakInfo => describeTarget(l.target);

function describeTarget(target: LabelTarget): PeakInfo {
  const l = { target };
  const p = l.target.peak;
  const wp = p.tags?.wikipedia;
  const m = wp ? /^([a-z\-]+):(.+)$/.exec(wp) : null;
  return {
    id: p.id,
    name: p.name,
    ele: p.ele ?? p.demEle ?? (p.kind === 'lake' ? l.target.anchorAlt : undefined),
    kind: p.kind === 'lake' ? 'lake' : 'peak',
    range: l.target.range,
    bearing: l.target.bearing,
    compass: COMPASS[Math.round(l.target.bearing / 45) % 8],
    wikipedia: m ? `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}` : undefined,
    wikidata: p.tags?.wikidata ? `https://www.wikidata.org/wiki/${p.tags.wikidata}` : undefined,
  };
}
