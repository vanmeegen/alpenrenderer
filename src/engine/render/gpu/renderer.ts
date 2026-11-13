/**
 * The renderer: Babylon.js on WebGPU or WebGL2, core modules only.
 *
 * Three passes. The terrain pass draws a polar mesh into an offscreen buffer
 * holding nothing but the distance to each fragment. The shade pass draws the
 * same mesh again into a colour buffer, lit from the elevation model. The
 * composite pass runs an edge detector over the range buffer and lays sky,
 * colour and outline together — or, in AR, the outline over the camera image,
 * washed towards white so the lines carry.
 *
 * Imports are individual modules rather than the barrel, so a build pulls in
 * the engine, one mesh, one material and one render target instead of the whole
 * of Babylon.
 */

// Must come first. Babylon's engine modules form an import cycle in which
// ThinWebGPUEngine is evaluated before AbstractEngine has finished defining
// itself; pulling the full engine module in ahead of them settles the order.
// Without it the bundle throws "Class extends value undefined" at load.
import '@babylonjs/core/Engines/engine';
import { Engine } from '@babylonjs/core/Engines/engine';
import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Constants } from '@babylonjs/core/Engines/constants';
import { Logger } from '@babylonjs/core/Misc/logger';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.rawTexture';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.videoTexture';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.readTexture';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.renderTarget';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.renderTargetTexture';
// The same six for WebGL. They are separate module graphs — importing only the
// WebGPU set leaves Engine.createDynamicTexture undefined, which does not
// surface until something asks for a video texture.
import '@babylonjs/core/Engines/Extensions/engine.rawTexture';
import '@babylonjs/core/Engines/Extensions/engine.dynamicTexture';
import '@babylonjs/core/Engines/Extensions/engine.videoTexture';
import '@babylonjs/core/Engines/Extensions/engine.readTexture';
import '@babylonjs/core/Engines/Extensions/engine.renderTarget';
import '@babylonjs/core/Engines/Extensions/engine.renderTargetTexture';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { VideoTexture } from '@babylonjs/core/Materials/Textures/videoTexture';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector2, Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Scene } from '@babylonjs/core/scene';

import { Camera } from '../../core/camera';
import { DEG, MERC_PX, REFRACTION_K, effectiveRadiusAt, localRadius } from '../../core/geodesy';
import { HeightField, Observer } from '../../core/heightfield';
import { FOG_RANGE, HORIZON_COLOR, SNOW_LINE, WATER_COLOR, sunVector } from '../shading';
import { Band, RadialParams, radialParams } from '../mesh';
import { RedrawGate, frameFingerprint } from '../redraw';
import { OUTLINE } from '../outline';
import { MAX_LEVELS, atlasLayout } from '../atlas';
import { levelSurface } from '../../core/surface';
import { DETAIL, detailFrame, detailTexture } from '../detail';
import { IMAGERY } from '../../sources/imagery';
import { QUALITY_HIGH, QUALITY_LOW, QUALITY_MID, Quality } from '../quality';
import { renderPixelRatio } from '../resolution';
import {
  COMPOSITE_FRAGMENT_GL, COMPOSITE_VERTEX_GL, TERRAIN_FRAGMENT_GL,
  TERRAIN_SHADE_FRAGMENT_GL, TERRAIN_VERTEX_GL,
} from './glsl';
import {
  COMPOSITE_FRAGMENT, COMPOSITE_UNIFORMS, COMPOSITE_VERTEX, HEIGHT_BIAS, HEIGHT_QUANT,
  SHADE_UNIFORMS, TERRAIN_FRAGMENT, TERRAIN_SHADE_FRAGMENT, TERRAIN_UNIFORMS,
  TERRAIN_VERTEX,
} from './wgsl';

const TERRAIN_MASK = 0x1;
const VIEW_MASK = 0x2;

/**
 * Which graphics API to draw with.
 *
 * WebGPU is the target. WebGL2 exists because it runs everywhere — including
 * under software rasterisation in CI, where a software WebGPU adapter is too
 * unstable to render a frame — so the picture can actually be checked. The two
 * paths share every uniform, both meshes and all the geometry; only the shader
 * dialect and the depth clip range differ.
 */
export type Backend = 'webgpu' | 'webgl2';

/** Writes a block of texels into a texture (ThinEngine and WebGPUEngine both implement it). */
interface SubUpload {
  updateTextureData(texture: unknown, data: ArrayBufferView, x: number, y: number, width: number, height: number): void;
}

export { QUALITY_HIGH, QUALITY_LOW, QUALITY_MID };
export type { Quality };

export interface RendererDiagnostics {
  webgpu: boolean;
  backend: Backend;
  engine: string;
  adapter: string;
  /** Anything Babylon logged as an error or warning, verbatim. */
  shaderErrors: string[];
  /** Whether each pipeline actually compiled. A shader that never becomes
   *  ready is silently skipped by Babylon, which looks like a blank screen. */
  terrainReady: boolean;
  shadeReady: boolean;
  compositeReady: boolean;
  framesDrawn: number;
  /** How often the GPU device has gone away. Backgrounding an AR app to save a
   *  photo is enough to cause it, so this is expected to be non-zero in use. */
  deviceLost: number;
  /** Frames that threw, and the first message. */
  frameErrors: number;
  lastError: string;
  levels: number;
  atlas: string;
  vertices: number;
  sectorsDrawn: number;
  frameMs: number;
  size: string;
  /** The device's WebGL limits that this renderer leans on, for reports from phones and tablets. */
  limits: string;
  /** gl.getError() after the last atlas upload; 0 is NO_ERROR. */
  glError: number;
}

export interface CaptureResult {
  width: number;
  height: number;
  /** RGBA, top-down. */
  pixels: Uint8Array;
}

/** True when this browser can run the app at all. */
export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export class GpuRenderer {
  readonly camera = new Camera();
  quality: Quality = QUALITY_HIGH;

  /**
   * Shaded 3D view (true) or the AR outline over the camera image (false).
   * The range pass runs either way; the shade pass only when shaded.
   */
  shaded = true;
  /** Strength of the ridge lines drawn over the shaded view, 0..1 (the app's "Konturen"). */
  outline = 0.7;
  /** Metres; snow above, rock and meadow below, blended over ~350 m. */
  snowLine = SNOW_LINE;
  /** Metres to 1/e of terrain colour in the aerial perspective. */
  fogRange = FOG_RANGE;
  skyTop: [number, number, number] = [0.36, 0.56, 0.86];
  horizonColor: [number, number, number] = [...HORIZON_COLOR];
  waterColor: [number, number, number] = [...WATER_COLOR];

  /** How far the camera image is washed towards white, 0..1. */
  whiten = 0.62;
  desaturate = 0.55;
  /** Scale of the ink line's width (outline.ts gives it in CSS pixels): the same line on a phone and a desktop. */
  edgeWidth = 1.0;
  /** The aerial style: the ground takes the colour of the picture wherever a level holds one (sources/imagery.ts). */
  aerial = false;
  /** The grain of the near ground in the shaded view (render/detail.ts), 0..1; 0 is off. */
  detail = 1;
  /** Strength of the haze rim behind ridges in the shaded view; 0 saves its eight taps. */
  rim = OUTLINE.rim;
  /**
   * The most device pixels per CSS pixel the frame is rendered at. A phone
   * with a ratio of 3 pays nine fragments per CSS pixel in three passes;
   * capped at 1.5 it pays a quarter of that and the lines stay as wide.
   */
  maxPixelRatio = Infinity;
  /**
   * Draws the frame this much coarser than `maxPixelRatio` allows, each way:
   * what the adaptation to slow frames asks for while the view moves
   * (render/adapt.ts); 1 at rest.
   */
  resolutionScale = 1;
  lineDark = 0.04;
  refractionK = REFRACTION_K;
  curvature = true;

  observer: Observer = { lon: 0, lat: 0, ground: 0, eye: 1.7 };
  heightField: HeightField | null = null;

  readonly diagnostics: RendererDiagnostics = {
    webgpu: false, backend: 'webgpu', engine: '', adapter: '', shaderErrors: [],
    terrainReady: false, shadeReady: false, compositeReady: false, framesDrawn: 0,
    deviceLost: 0, frameErrors: 0, lastError: '',
    levels: 0, atlas: '', vertices: 0, sectorsDrawn: 0, frameMs: 0, size: '',
    limits: '', glError: 0,
  };
  /** The raw WebGL2 context, for limits and error state; null on WebGPU. */
  private gl2: WebGL2RenderingContext | null = null;

  private engine!: AbstractEngine;
  private scene!: Scene;
  private viewCam!: FreeCamera;
  private terrainCam!: FreeCamera;
  private sectors: Mesh[] = [];
  private terrainMat!: ShaderMaterial;
  private shadeMat!: ShaderMaterial;
  private compositeMat!: ShaderMaterial;
  private quad!: Mesh;
  private rangeRtt!: RenderTargetTexture;
  private colorRtt!: RenderTargetTexture;
  private atlas: RawTexture | null = null;
  /** One level's texels, packed for upload; and the atlas's size as "w×h". */
  private levelBlock: Uint8Array | null = null;
  private atlasShape = '';
  private atlasLevelPx = 0;
  /**
   * Normal and occlusion per post (core/surface.ts), laid out like the
   * height atlas; `surfaced` holds the version of each level it was built
   * from. Only the shade pass reads it, so it is only built when shaded.
   */
  private surfaceAtlas: RawTexture | null = null;
  private surfaceBlock: Uint8Array | null = null;
  private surfaced: string[] = [];
  /**
   * The aerial picture, one cell per level at half the level's size, laid
   * out like the height atlas; `pictured` holds what each cell was sent
   * from. Built only in the aerial style.
   */
  private imageryAtlas: RawTexture | null = null;
  private pictured: string[] = [];
  private blank!: RawTexture;
  private video: VideoTexture | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private still: RawTexture | null = null;
  private stillSize: { width: number; height: number } | null = null;
  private lvlA = new Float32Array(MAX_LEVELS * 4);
  private lvlB = new Float32Array(MAX_LEVELS * 4);
  private uploaded: string[] = [];
  private frameTimes: number[] = [];
  private disposed = false;

  private constructor(readonly canvas: HTMLCanvasElement, readonly backend: Backend) {}

  static async create(canvas: HTMLCanvasElement, quality?: Quality,
    backend: Backend = 'webgpu'): Promise<GpuRenderer> {
    if (backend === 'webgpu' && !webgpuAvailable()) {
      throw new Error('This browser has no WebGPU. The renderer needs it — try '
        + 'Chrome or Edge 121+, or Safari 26+ on iOS 26.');
    }
    const r = new GpuRenderer(canvas, backend);
    if (quality) r.quality = quality;
    try {
      await r.init();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (backend === 'webgl2') throw new Error(`WebGL2 would not start.\n\n${why}`);
      // A present navigator.gpu is not the same as a usable one: virtual
      // machines, remote desktops and browsers started without GPU access all
      // expose the API and then hand back no adapter. Say which it was.
      throw new Error(`WebGPU is present but would not start.\n\n${why}\n\n`
        + 'This usually means the device or browser has no usable GPU adapter — '
        + 'a virtual machine, a remote session, or hardware acceleration turned '
        + 'off in the browser settings.');
    }
    return r;
  }

  private async init() {
    // Babylon reports a failed shader by logging and then quietly refusing to
    // draw the mesh, which on screen is indistinguishable from an empty scene.
    // Capture everything it says so the Check panel can show the real reason.
    this.captureLogs();

    const d = this.diagnostics;
    d.backend = this.backend;

    if (this.backend === 'webgl2') {
      ShaderStore.ShadersStore.terrainVertexShader = TERRAIN_VERTEX_GL;
      ShaderStore.ShadersStore.terrainFragmentShader = TERRAIN_FRAGMENT_GL;
      ShaderStore.ShadersStore.shadeVertexShader = TERRAIN_VERTEX_GL;
      ShaderStore.ShadersStore.shadeFragmentShader = TERRAIN_SHADE_FRAGMENT_GL;
      ShaderStore.ShadersStore.compositeVertexShader = COMPOSITE_VERTEX_GL;
      ShaderStore.ShadersStore.compositeFragmentShader = COMPOSITE_FRAGMENT_GL;

      const gl = new Engine(this.canvas, false, {
        antialias: false,
        stencil: false,
        preserveDrawingBuffer: false,
      }, true);
      if (gl.webGLVersion < 2) {
        gl.dispose();
        throw new Error('This browser only offers WebGL1, which cannot run these shaders.');
      }
      this.engine = gl;
      d.webgpu = false;
      d.engine = `Babylon.js WebGL${gl.webGLVersion}`;
      d.adapter = gl.getGlInfo().renderer || 'unreported';
      // What this renderer asks of the device: an atlas of up to 1280×3200, texture
      // fetches in the vertex stage, two vec4[8] uniform arrays, highp there.
      const g = (gl as unknown as { _gl: WebGL2RenderingContext })._gl;
      this.gl2 = g;
      const highp = g.getShaderPrecisionFormat(g.VERTEX_SHADER, g.HIGH_FLOAT);
      d.limits = `Textur ${g.getParameter(g.MAX_TEXTURE_SIZE)} · Vertex-Texturen ${g.getParameter(g.MAX_VERTEX_TEXTURE_IMAGE_UNITS)}`
        + ` · Vertex-Uniforms ${g.getParameter(g.MAX_VERTEX_UNIFORM_VECTORS)} · highp Vertex ${highp ? highp.precision : 0} Bit`;
      // WebGL clips depth to [-1,1]; the GLSL remap ends on the same interval.
      this.camera.depthZeroToOne = false;
    } else {
      ShaderStore.ShadersStoreWGSL.terrainVertexShader = TERRAIN_VERTEX;
      ShaderStore.ShadersStoreWGSL.terrainFragmentShader = TERRAIN_FRAGMENT;
      ShaderStore.ShadersStoreWGSL.shadeVertexShader = TERRAIN_VERTEX;
      ShaderStore.ShadersStoreWGSL.shadeFragmentShader = TERRAIN_SHADE_FRAGMENT;
      ShaderStore.ShadersStoreWGSL.compositeVertexShader = COMPOSITE_VERTEX;
      ShaderStore.ShadersStoreWGSL.compositeFragmentShader = COMPOSITE_FRAGMENT;

      const wgpu = new WebGPUEngine(this.canvas, {
        antialias: false,        // edges come from the detector, not from MSAA
        stencil: false,
        adaptToDeviceRatio: true,
        powerPreference: 'high-performance',
      });
      await wgpu.initAsync();
      this.engine = wgpu;
      d.webgpu = true;
      d.engine = `Babylon.js ${wgpu.description ?? 'WebGPU'}`;
      const info = (wgpu as unknown as { _adapterInfo?: Record<string, string> })._adapterInfo;
      d.adapter = info
        ? `${info.vendor ?? '?'} ${info.architecture ?? ''} ${info.description ?? ''}`.trim()
        : 'unreported';
      this.camera.depthZeroToOne = true;
    }

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 1);
    this.scene.autoClear = true;
    this.scene.skipPointerMovePicking = true;
    this.scene.detachControl();

    this.viewCam = new FreeCamera('view', Vector3.Zero(), this.scene);
    this.viewCam.layerMask = VIEW_MASK;
    this.terrainCam = new FreeCamera('terrain', Vector3.Zero(), this.scene);
    this.terrainCam.layerMask = TERRAIN_MASK;
    this.scene.activeCamera = this.viewCam;

    this.blank = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1,
      this.scene, false, false, Texture.NEAREST_SAMPLINGMODE);

    this.buildTerrainMaterial();
    this.buildRangeTarget();
    this.buildColorTarget();
    this.buildComposite();
    this.buildSectors();

    // Losing the device is normal on a phone: backgrounding the app to save a
    // photo, or a driver reset under thermal load, is enough. Babylon rebuilds
    // its own resources, but the height atlas is ours — it has to be re-sent or
    // the terrain comes back empty, which reads as a silent failure.
    this.engine.onContextLostObservable.add(() => {
      d.deviceLost++;
      d.shaderErrors.push(`WebGPU device lost (${d.deviceLost})`);
    });
    this.engine.onContextRestoredObservable.add(() => {
      this.atlas?.dispose();
      this.atlas = null;
      this.dropSurface();
      this.uploaded = this.uploaded.map(() => '');
      if (this.heightField) this.setHeightField(this.heightField);
      this.gate.request(2);
    });
  }

  private captureLogs() {
    const d = this.diagnostics;
    const keep = (prefix: string) => (msg: string) => {
      const text = `${prefix}${typeof msg === 'string' ? msg : String(msg)}`;
      if (!d.shaderErrors.includes(text)) d.shaderErrors.push(text);
      if (d.shaderErrors.length > 40) d.shaderErrors.shift();
    };
    const origError = Logger.Error;
    const origWarn = Logger.Warn;
    Logger.Error = (m: string | any[], limit?: number) => { keep('')(String(m)); origError(m, limit); };
    Logger.Warn = (m: string | any[], limit?: number) => { keep('warn: ')(String(m)); origWarn(m, limit); };
  }

  /** Did each pipeline actually compile? Recorded every frame. */
  private pollShaders() {
    const d = this.diagnostics;
    const mats = [
      ['terrain', this.terrainMat], ['shade', this.shadeMat], ['composite', this.compositeMat],
    ] as const;
    for (const [name, mat] of mats) {
      const effect = mat?.getEffect?.();
      const ready = !!mat && mat.isReady(name === 'composite' ? this.quad : this.sectors[0]);
      if (name === 'terrain') d.terrainReady = ready;
      else if (name === 'shade') d.shadeReady = ready;
      else d.compositeReady = ready;
      const err = effect?.getCompilationError?.();
      if (err) {
        const text = `${name} shader: ${err}`;
        if (!d.shaderErrors.includes(text)) d.shaderErrors.push(text);
      }
    }
  }

  // ------------------------------------------------------------------ passes

  /** WGSL or GLSL, depending on which engine was created. */
  private get shaderLanguage(): ShaderLanguage {
    return this.backend === 'webgl2' ? ShaderLanguage.GLSL : ShaderLanguage.WGSL;
  }

  private buildTerrainMaterial() {
    this.terrainMat = new ShaderMaterial('terrain', this.scene,
      { vertex: 'terrain', fragment: 'terrain' }, {
        attributes: ['position'],
        uniforms: [...TERRAIN_UNIFORMS],
        samplers: ['heights'],
        shaderLanguage: this.shaderLanguage,
      });
    this.terrainMat.backFaceCulling = false;
    this.terrainMat.setTexture('heights', this.blank);

    // Same vertex stage, lit fragment stage. Drawn by the colour target in
    // place of the range material (setMaterialForRendering), so one set of
    // sector meshes serves both passes.
    this.shadeMat = new ShaderMaterial('shade', this.scene,
      { vertex: 'shade', fragment: 'shade' }, {
        attributes: ['position'],
        uniforms: [...SHADE_UNIFORMS],
        samplers: ['heights', 'surface', 'detail', 'imagery'],
        shaderLanguage: this.shaderLanguage,
      });
    this.shadeMat.backFaceCulling = false;
    this.shadeMat.setTexture('heights', this.blank);
    this.shadeMat.setTexture('surface', this.blank);
    // The grain tile repeats and is seen from far off: wrapped, with mips.
    const grain = new RawTexture(detailTexture(), DETAIL.size, DETAIL.size, Constants.TEXTUREFORMAT_RGBA,
      this.scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    grain.wrapU = Texture.WRAP_ADDRESSMODE;
    grain.wrapV = Texture.WRAP_ADDRESSMODE;
    this.shadeMat.setTexture('detail', grain);
    this.shadeMat.setTexture('imagery', this.blank);
  }

  private buildColorTarget() {
    this.colorRtt = new RenderTargetTexture('color', { width: 2, height: 2 }, this.scene, {
      generateDepthBuffer: true,
      generateMipMaps: false,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      format: Constants.TEXTUREFORMAT_RGBA,
    });
    // Alpha zero is sky; the composite paints its gradient there.
    this.colorRtt.clearColor = new Color4(0, 0, 0, 0);
    this.colorRtt.activeCamera = this.terrainCam;
    this.colorRtt.renderList = [];
    this.scene.customRenderTargets.push(this.colorRtt);
  }

  private buildRangeTarget() {
    this.rangeRtt = new RenderTargetTexture('range', { width: 2, height: 2 }, this.scene, {
      generateDepthBuffer: true,
      generateMipMaps: false,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      format: Constants.TEXTUREFORMAT_RGBA,
    });
    // Alpha zero marks sky; the edge detector reads that as "infinitely far",
    // which is what makes the outer skyline an edge like any other.
    this.rangeRtt.clearColor = new Color4(0, 0, 0, 0);
    this.rangeRtt.activeCamera = this.terrainCam;
    this.rangeRtt.renderList = [];
    this.scene.customRenderTargets.push(this.rangeRtt);
  }

  private buildComposite() {
    this.compositeMat = new ShaderMaterial('composite', this.scene,
      { vertex: 'composite', fragment: 'composite' }, {
        attributes: ['position'],
        uniforms: [...COMPOSITE_UNIFORMS],
        samplers: ['rangeTex', 'colorTex', 'videoTex'],
        shaderLanguage: this.shaderLanguage,
      });
    this.compositeMat.backFaceCulling = false;
    this.compositeMat.disableDepthWrite = true;
    this.compositeMat.setTexture('rangeTex', this.rangeRtt);
    this.compositeMat.setTexture('colorTex', this.colorRtt);
    this.compositeMat.setTexture('videoTex', this.blank);

    this.quad = new Mesh('composite', this.scene);
    const vd = new VertexData();
    vd.positions = [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0];
    vd.indices = [0, 1, 2, 2, 1, 3];
    vd.applyToMesh(this.quad);
    this.quad.material = this.compositeMat;
    this.quad.layerMask = VIEW_MASK;
    this.quad.alwaysSelectAsActiveMesh = true;
    this.quad.isPickable = false;
    this.quad.doNotSyncBoundingInfo = true;
    // No infiniteDistance: the vertex shader already emits clip-space
    // positions, and that flag has Babylon fit a camera-following world matrix
    // the quad neither needs nor wants.
  }

  /**
   * The polar mesh, split into azimuth sectors so only the wedge in front of
   * the camera is submitted — about a sixth of the panorama at a typical field
   * of view, and the difference between a warm phone and a hot one.
   */
  private buildSectors() {
    for (const m of this.sectors) m.dispose(false, true);
    this.sectors = [];
    const { azimuths, rows, sectors } = this.quality;
    const cols = Math.ceil(azimuths / sectors);
    let verts = 0;

    for (let s = 0; s < sectors; s++) {
      const a0 = s * cols;
      const n = Math.min(cols, azimuths - a0);
      if (n <= 0) break;
      const w = n + 1;
      const positions = new Float32Array(w * rows * 3);
      for (let j = 0, p = 0; j < rows; j++) {
        for (let i = 0; i < w; i++, p += 3) {
          positions[p] = a0 + i;      // azimuth index, wraps naturally in the shader
          positions[p + 1] = j;       // radial row
          positions[p + 2] = 0;
        }
      }
      const quads = n * (rows - 1);
      const indices = w * rows > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
      let k = 0;
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < n; i++) {
          const a = j * w + i, b = a + 1, c = a + w, dd = c + 1;
          indices[k++] = a; indices[k++] = c; indices[k++] = b;
          indices[k++] = b; indices[k++] = c; indices[k++] = dd;
        }
      }
      const mesh = new Mesh(`sector${s}`, this.scene);
      const vd = new VertexData();
      vd.positions = positions;
      vd.indices = indices as unknown as number[];
      vd.applyToMesh(mesh, false);
      mesh.material = this.terrainMat;
      mesh.layerMask = TERRAIN_MASK;
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.doNotSyncBoundingInfo = true;
      mesh.setEnabled(false);
      this.sectors.push(mesh);
      verts += w * rows;
    }
    this.diagnostics.vertices = verts;
    this.rangeRtt.renderList = this.sectors;
    this.colorRtt.renderList = this.sectors;
    this.colorRtt.setMaterialForRendering(this.sectors, this.shadeMat);
  }

  // ------------------------------------------------------------------- data

  /**
   * Uploads the clipmap as one stacked rgba8 atlas: levels tile down the
   * texture, height packed as (R*256 + G) + bias, the lake mask in B. Integer and float texture
   * formats each come with device-dependent conditions; eight-bit channels do
   * not, and three bytes of range at one-metre steps is all the model holds.
   */
  setHeightField(hf: HeightField) {
    this.heightField = hf;
    const levels = hf.levels;
    if (!levels.length) return;
    const { w, h } = levels[0];
    for (const l of levels) {
      if (l.w !== w || l.h !== h) throw new Error('clipmap levels must share a size');
    }
    // The levels lie two abreast (render/atlas.ts); a level that changed is
    // packed into its own block and sent alone, not the whole atlas with it.
    const layout = atlasLayout(levels.length, h);
    const shape = `${layout.width}×${layout.height}`;
    if (this.atlasShape !== shape) {
      this.atlasShape = shape;
      this.atlas?.dispose();
      this.atlas = null;
      this.dropSurface();
    }
    if (!this.atlas) {
      this.atlas = new RawTexture(null, layout.width, layout.height, Constants.TEXTUREFORMAT_RGBA,
        this.scene, false, false, Texture.NEAREST_SAMPLINGMODE);
      this.atlas.wrapU = Texture.CLAMP_ADDRESSMODE;
      this.atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.terrainMat.setTexture('heights', this.atlas);
      this.shadeMat.setTexture('heights', this.atlas);
      this.uploaded = levels.map(() => '');
    }
    this.atlasLevelPx = h;
    if (!this.levelBlock || this.levelBlock.length !== w * h * 4) this.levelBlock = new Uint8Array(w * h * 4);
    const block = this.levelBlock;
    const texture = this.atlas.getInternalTexture();

    levels.forEach((l, i) => {
      const stamp = `${l.version}:${l.waterVersion ?? 0}:${l.coverVersion ?? 0}`;
      if (this.uploaded[i] === stamp) return;
      const raw = l.raw;
      const water = l.water && l.water.length === raw.length ? l.water : null;
      const cover = l.cover && l.cover.length === raw.length ? l.cover : null;
      for (let p = 0, o = 0; p < raw.length; p++, o += 4) {
        // The stored value is already quantised; re-express it in the
        // atlas's own steps so one packing works for every level.
        const m = Math.round((raw[p] * l.quant + l.bias - HEIGHT_BIAS) / HEIGHT_QUANT);
        const v = m < 0 ? 0 : m > 65535 ? 65535 : m;
        block[o] = v >> 8;
        block[o + 1] = v & 255;
        block[o + 2] = water ? water[p] : 0;   // lake mask, see core/water.ts
        block[o + 3] = cover ? cover[p] << 4 : 0;   // land cover class, sixteen to the class
      }
      const at = layout.origin(i);
      // Both engines have it; the type they share does not declare it.
      if (texture) (this.engine as unknown as SubUpload).updateTextureData(texture, block, at.x, at.y, w, h);
      this.uploaded[i] = stamp;
    });
    if (this.shaded) this.syncSurface();
    if (this.shaded && this.aerial) this.syncImagery();
    if (this.gl2) this.diagnostics.glError = this.gl2.getError();

    this.diagnostics.levels = levels.length;
    this.diagnostics.atlas = `${shape} rgba8`;
    this.syncLevels(hf);
  }

  private dropSurface() {
    this.surfaceAtlas?.dispose();
    this.surfaceAtlas = null;
    this.surfaced = [];
    this.shadeMat?.setTexture('surface', this.blank);
    this.imageryAtlas?.dispose();
    this.imageryAtlas = null;
    this.pictured = [];
    this.shadeMat?.setTexture('imagery', this.blank);
  }

  /** Pixels of the aerial picture per level side, and where its cells lie. */
  private imageryLayout(levels: number) {
    const cell = Math.floor(this.atlasLevelPx / IMAGERY.shrink);
    return { cell, layout: atlasLayout(levels, cell) };
  }

  /**
   * Brings the picture atlas up to the levels: a level whose picture
   * changed is sent alone; one that lost its picture is sent see-through,
   * so the relief shows there. Called when levels arrive and before a
   * frame in the aerial style.
   */
  private syncImagery() {
    const hf = this.heightField;
    if (!hf || !hf.levels.length || !this.atlas) return;
    const levels = hf.levels;
    const stampOf = (l: (typeof levels)[number]) => (l.imagery ? `${l.imageryVersion ?? 0}` : '');
    if (this.imageryAtlas && !levels.some((l, i) => (this.pictured[i] ?? '') !== stampOf(l))) return;
    const { cell, layout } = this.imageryLayout(levels.length);
    if (!this.imageryAtlas) {
      // Read between its pixels by the sampler: the picture is colour, a texel off is nothing.
      this.imageryAtlas = new RawTexture(new Uint8Array(layout.width * layout.height * 4), layout.width, layout.height,
        Constants.TEXTUREFORMAT_RGBA, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
      this.imageryAtlas.wrapU = Texture.CLAMP_ADDRESSMODE;
      this.imageryAtlas.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.shadeMat.setTexture('imagery', this.imageryAtlas);
      this.pictured = levels.map(() => '');
    }
    const texture = this.imageryAtlas.getInternalTexture();
    levels.forEach((l, i) => {
      const stamp = stampOf(l);
      if ((this.pictured[i] ?? '') === stamp) return;
      const block = l.imagery && l.imagery.length === cell * cell * 4 ? l.imagery : new Uint8Array(cell * cell * 4);
      const at = layout.origin(i);
      if (texture) (this.engine as unknown as SubUpload).updateTextureData(texture, block, at.x, at.y, cell, cell);
      this.pictured[i] = stamp;
    });
  }

  /**
   * Brings the surface atlas up to the heights: every filled level whose
   * heights changed since is worked out again (core/surface.ts) and sent
   * alone. Called when heights arrive and before a shaded frame, so turning
   * the shading on later finds it built.
   */
  private syncSurface() {
    const hf = this.heightField;
    if (!hf || !hf.levels.length || !this.atlas) return;
    const levels = hf.levels;
    if (!levels.some((l, i) => l.filled && this.surfaced[i] !== String(l.version))) return;
    const { w, h } = levels[0];
    const layout = atlasLayout(levels.length, h);
    if (!this.surfaceAtlas) {
      this.surfaceAtlas = new RawTexture(null, layout.width, layout.height, Constants.TEXTUREFORMAT_RGBA,
        this.scene, false, false, Texture.NEAREST_SAMPLINGMODE);
      this.surfaceAtlas.wrapU = Texture.CLAMP_ADDRESSMODE;
      this.surfaceAtlas.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.shadeMat.setTexture('surface', this.surfaceAtlas);
      this.surfaced = levels.map(() => '');
    }
    if (!this.surfaceBlock || this.surfaceBlock.length !== w * h * 4) this.surfaceBlock = new Uint8Array(w * h * 4);
    const block = this.surfaceBlock;
    const texture = this.surfaceAtlas.getInternalTexture();
    levels.forEach((l, i) => {
      const stamp = String(l.version);
      if (!l.filled || this.surfaced[i] === stamp) return;
      levelSurface(l.raw, w, h, l.quant, l.res, block);
      const at = layout.origin(i);
      if (texture) (this.engine as unknown as SubUpload).updateTextureData(texture, block, at.x, at.y, w, h);
      this.surfaced[i] = stamp;
    });
  }

  private syncLevels(hf: HeightField) {
    hf.levels.forEach((l, i) => {
      const pxPerRad = (MERC_PX * (1 << l.z)) / (2 * Math.PI);
      // A level that has not been fetched yet advertises no range, so the
      // shader's search for the finest level covering a point steps over it.
      // Otherwise a cold start draws the empty raster's uniform bias as a plain
      // at -1000 m in the foreground, with a cliff up to the real terrain
      // wherever the next level takes over.
      // A look level (the telescope's window) is flagged below zero: the
      // shader takes it wherever the point lies inside its window, not by
      // range, and by as much as the flag says (minus its weight, -1 once it
      // has risen all the way: core/lookfade.ts).
      const weight = Math.min(1, Math.max(0, l.weight ?? 1));
      this.lvlA.set([l.cx, l.cy, pxPerRad, l.role === 'look' ? (l.filled ? -weight : 0) : (l.filled ? l.maxRange : 0)], i * 4);
      // Heights were re-expressed in the atlas's steps when it was packed.
      this.lvlB.set([HEIGHT_QUANT, HEIGHT_BIAS, l.w, l.h], i * 4);
    });
    this.camera.far = Math.max(1000, hf.maxRange * 1.15);
  }

  moveTo(lon: number, lat: number, eyeAlt: number) {
    const hf = this.heightField;
    if (!hf) return;
    if (lon !== hf.lon || lat !== hf.lat) hf.setOrigin(lon, lat);
    this.observer = { lon, lat, ground: eyeAlt - this.observer.eye, eye: this.observer.eye };
    this.eyeAltitude = eyeAlt;
    this.syncLevels(hf);
  }

  /** Absolute altitude of the eye, metres. Set from GPS or the DEM. */
  eyeAltitude = 0;

  attachVideo(el: HTMLVideoElement | null) {
    this.detachFrame();
    this.videoEl = el;
    if (!el) return;
    this.video = new VideoTexture('feed', el, this.scene, false, true,
      Texture.BILINEAR_SAMPLINGMODE, { autoPlay: false, autoUpdateTexture: true, loop: false });
    this.video.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.video.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.compositeMat.setTexture('videoTex', this.video);
  }

  /**
   * A still image behind the outline instead of the camera: a photo. Same
   * composite path as the video, same cover-crop, from RGBA pixels top-down.
   */
  attachStill(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number) {
    this.detachFrame();
    const data = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    // The video path samples with v flipped (1 - uv.y); a top-down image
    // wants the same orientation, so it is uploaded as is with invertY off.
    this.still = RawTexture.CreateRGBATexture(data, width, height, this.scene, false, false,
      Texture.BILINEAR_SAMPLINGMODE);
    this.still.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.still.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.stillSize = { width, height };
    this.compositeMat.setTexture('videoTex', this.still);
  }

  private detachFrame() {
    if (this.video) { this.video.dispose(); this.video = null; }
    if (this.still) { this.still.dispose(); this.still = null; }
    this.videoEl = null;
    this.stillSize = null;
    this.compositeMat.setTexture('videoTex', this.blank);
    this.frameVersion++;
  }

  // ----------------------------------------------------------------- render

  /** The telescope's dense band of rings, set by the viewer when zoomed in; null otherwise. */
  band: Band | null = null;

  /** Draws only what changed (render/redraw.ts): the first frames, then on any new input, request or live source. */
  private readonly gate = new RedrawGate(3);
  /** Bumped when the texture behind the outline (video, still, none) is swapped. */
  private frameVersion = 0;

  /** Draw the next `n` frames whatever the inputs changed. */
  requestRedraw(n = 1) { this.gate.request(n); }

  /** Everything a frame depends on, for the gate's fingerprint. */
  private frameInputs() {
    const hf = this.heightField!;
    const c = this.camera;
    return {
      camera: { yaw: c.yaw, pitch: c.pitch, roll: c.roll, fov: c.fov },
      size: {
        w: this.canvas.clientWidth, h: this.canvas.clientHeight,
        scale: this.engine.getHardwareScalingLevel() * (globalThis.devicePixelRatio ?? 1),
      },
      eye: this.eyeAltitude,
      origin: [hf.lon, hf.lat] as [number, number],
      levels: hf.levels.map((l) => ({
        version: l.version, waterVersion: l.waterVersion, coverVersion: l.coverVersion, imageryVersion: l.imageryVersion,
        weight: l.weight, filled: l.filled, px0: l.px0, py0: l.py0,
      })),
      knobs: {
        shaded: this.shaded, aerial: this.aerial, outline: this.outline, detail: this.detail, snowLine: this.snowLine, fogRange: this.fogRange,
        skyTop: this.skyTop, horizonColor: this.horizonColor, waterColor: this.waterColor,
        whiten: this.whiten, desaturate: this.desaturate, rim: this.rim, maxPixelRatio: this.maxPixelRatio,
        resolutionScale: this.resolutionScale,
        edgeWidth: this.edgeWidth, lineDark: this.lineDark, refractionK: this.refractionK, curvature: this.curvature,
        band: this.band ? [this.band.r1, this.band.r2] : null, frame: this.frameVersion,
      },
    };
  }

  /** A source that changes every frame: the camera image, or the pipelines still compiling (pollShaders runs per drawn frame). */
  private liveSource(): boolean {
    const d = this.diagnostics;
    return this.videoEl !== null || !(d.terrainReady && d.shadeReady && d.compositeReady);
  }

  /** The ring and column layout for the current view: the wedge follows the camera, the band the zoom. */
  private radialParams(hf: HeightField) {
    return radialParams(this.quality, hf, this.camera.azimuthArc(4), this.band);
  }

  /** The ring layout the mesh uses now; see render/mesh.ts. */
  meshParams(): RadialParams | null {
    return this.heightField ? this.radialParams(this.heightField) : null;
  }

  resize(): { w: number; h: number } {
    const cssW = this.canvas.clientWidth || 640;
    const cssH = this.canvas.clientHeight || 360;
    const scaling = Math.max(1, this.resolutionScale) / renderPixelRatio(globalThis.devicePixelRatio ?? 1, this.maxPixelRatio);
    if (Math.abs(this.engine.getHardwareScalingLevel() - scaling) > 1e-6) this.engine.setHardwareScalingLevel(scaling);
    this.engine.resize();
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    this.camera.aspect = w / Math.max(1, h);
    if (this.rangeRtt.getSize().width !== w || this.rangeRtt.getSize().height !== h) {
      this.rangeRtt.resize({ width: w, height: h });
      this.colorRtt.resize({ width: w, height: h });
    }
    this.diagnostics.size = `${w}×${h} (css ${cssW}×${cssH})`;
    return { w, h };
  }

  /** Draws the frame when something changed; returns whether it drew. */
  render(): boolean {
    if (this.disposed || !this.heightField) return false;
    if (!this.gate.need(frameFingerprint(this.frameInputs()), this.liveSource())) return false;
    const t0 = performance.now();
    try {
      const { w, h } = this.resize();
      this.camera.update();
      if (this.shaded) this.syncSurface();
      if (this.shaded && this.aerial) this.syncImagery();
      this.updateTerrainUniforms();
      this.updateCompositeUniforms(w, h);
      this.scene.render();
      this.pollShaders();
      this.diagnostics.framesDrawn++;
    } catch (e) {
      // A frame that throws must not take the app with it. Losing the device
      // mid-frame is the common cause and Babylon recovers from it a frame or
      // two later; the caller keeps asking for frames and this keeps a record
      // of what went wrong so the Check panel can show it.
      const d = this.diagnostics;
      d.frameErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      if (!d.lastError) d.lastError = msg;
      if (!d.shaderErrors.includes(`frame: ${msg}`)) d.shaderErrors.push(`frame: ${msg}`);
    }
    const dt = performance.now() - t0;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    this.diagnostics.frameMs = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return true;
  }

  private updateTerrainUniforms() {
    const hf = this.heightField!;
    // A look window's weight changes from frame to frame while it rises.
    this.syncLevels(hf);
    const p = this.radialParams(hf);
    const latR = hf.lat * DEG;

    for (const m of [this.terrainMat, this.shadeMat]) {
      m.setFloat('uAz0', p.az0);
      m.setFloat('uAzStep', p.azStep);
      m.setVector4('uRadial', new Vector4(p.jNear, p.logRatioNear, p.jSplit, p.logRatioFar));
      m.setVector4('uRadialB', new Vector4(p.r0, p.rNearEnd, p.post, p.rSplit));
      m.setFloat('uSinLat0', Math.sin(latR));
      m.setFloat('uCosLat0', Math.cos(latR));
      m.setFloat('uEyeAlt', this.eyeAltitude);
      m.setFloat('uRadius', localRadius(hf.lat));
      m.setFloat('uRefRadius', effectiveRadiusAt(hf.lat, this.refractionK));
      m.setFloat('uDropScale', this.curvature ? 1 : 0);
      m.setFloat('uLevelCount', hf.levels.length);
      const atlas = atlasLayout(hf.levels.length, this.atlasLevelPx);
      m.setVector2('uTexSize', new Vector2(atlas.width, atlas.height));
      m.setFloat('uLevelPx', this.atlasLevelPx);
      m.setFloat('uFar', this.camera.far);
      m.setMatrix('uViewProj', Matrix.FromArray(this.camera.viewProj));
      m.setArray4('uLvlA', Array.from(this.lvlA));
      m.setArray4('uLvlB', Array.from(this.lvlB));
    }
    const sm = this.shadeMat;
    // The light turns with the view: over the viewer's left shoulder (shading.ts SUN).
    sm.setVector3('uSun', Vector3.FromArray(sunVector(this.camera.yaw)));
    sm.setFloat('uSnowLine', this.snowLine);
    sm.setFloat('uFogRange', this.fogRange);
    sm.setVector3('uHorizonColor', Vector3.FromArray(this.horizonColor));
    sm.setVector3('uWaterColor', Vector3.FromArray(this.waterColor));
    const grain = detailFrame(hf.lon, hf.lat);
    sm.setVector3('uDetail', new Vector3(grain.scale[0], grain.scale[1], this.detail));
    sm.setVector4('uDetailOrigin', new Vector4(...grain.origin));
    const picture = this.imageryLayout(hf.levels.length);
    sm.setVector4('uImagery', new Vector4(this.aerial && this.imageryAtlas ? 1 : 0, picture.cell, picture.layout.width, picture.layout.height));
    // The shade pass is only worth its vertex cost when it will be seen.
    this.colorRtt.renderList = this.shaded ? this.sectors : [];

    // The wedge is the view: every sector is drawn.
    for (const sector of this.sectors) sector.setEnabled(true);
    this.diagnostics.sectorsDrawn = this.sectors.length;
  }

  private updateCompositeUniforms(w: number, h: number) {
    const m = this.compositeMat;
    m.setVector2('uTexel', new Vector2(1 / w, 1 / h));
    m.setFloat('uEdgeWidth', this.edgeWidth / this.engine.getHardwareScalingLevel());
    m.setFloat('uRim', this.shaded ? this.rim : 0);
    m.setFloat('uWhiten', this.whiten);
    m.setFloat('uDesat', this.desaturate);
    m.setFloat('uLineDark', this.lineDark);
    const vw = this.stillSize?.width ?? this.videoEl?.videoWidth ?? 0;
    const vh = this.stillSize?.height ?? this.videoEl?.videoHeight ?? 0;
    const ready = (!!this.video || !!this.still) && vw > 0 && vh > 0;
    m.setFloat('uHasVideo', ready ? 1 : 0);
    // Reproduce object-fit: cover, so the overlay lines up with the frame.
    let sx = 1, sy = 1;
    if (ready) {
      const canvasAspect = w / h;
      const videoAspect = vw / vh;
      if (canvasAspect > videoAspect) sy = videoAspect / canvasAspect;
      else sx = canvasAspect / videoAspect;
    }
    m.setVector2('uVideoScale', new Vector2(sx, sy));

    m.setFloat('uShade', this.shaded ? 1 : 0);
    m.setFloat('uOutline', this.outline);
    const c = this.camera;
    m.setVector3('uCamFwd', Vector3.FromArray(c.forward));
    m.setVector3('uCamRight', Vector3.FromArray(c.right));
    m.setVector3('uCamUp', Vector3.FromArray(c.up));
    const tv = Math.tan((c.fov * DEG) / 2);
    m.setVector2('uTanHalf', new Vector2(tv * c.aspect, tv));
    m.setVector3('uSkyTop', Vector3.FromArray(this.skyTop));
    m.setVector3('uHorizonColor', Vector3.FromArray(this.horizonColor));
  }

  /**
   * The range buffer, read back. Only the checks use this — it stalls the
   * pipeline — but "did the terrain pass write anything?" is otherwise
   * unanswerable from outside, and it is the first question worth asking when
   * the screen is empty.
   */
  async readRange(): Promise<CaptureResult | null> {
    // The buffers are as of the last drawn frame; a change since then is drawn first (the gate decides).
    this.render();
    const { width, height } = this.rangeRtt.getSize();
    const data = await this.rangeRtt.readPixels();
    if (!data) return null;
    return { width, height, pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  }

  /**
   * Renders the composite once more into a buffer and reads it back. The
   * terrain buffers it composites are brought up to date first: a frame is
   * drawn only when an input changed since the last one (the gate), and a
   * caller between two animation frames must not get the previous view.
   */
  async capture(): Promise<CaptureResult | null> {
    this.render();
    const { w, h } = this.resize();
    const rtt = new RenderTargetTexture('capture', { width: w, height: h }, this.scene, {
      generateDepthBuffer: false,
      generateMipMaps: false,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      format: Constants.TEXTUREFORMAT_RGBA,
    });
    rtt.renderList = [this.quad];
    rtt.activeCamera = this.viewCam;
    rtt.clearColor = new Color4(0, 0, 0, 1);
    try {
      this.updateCompositeUniforms(w, h);
      rtt.render(false, false);
      const data = await rtt.readPixels();
      if (!data) return null;
      const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      // Render targets read back bottom-up; images are top-down.
      const out = new Uint8Array(w * h * 4);
      const stride = w * 4;
      for (let y = 0; y < h; y++) {
        out.set(src.subarray((h - 1 - y) * stride, (h - y) * stride), y * stride);
      }
      return { width: w, height: h, pixels: out };
    } finally {
      rtt.dispose();
    }
  }

  dispose() {
    this.disposed = true;
    this.video?.dispose();
    this.still?.dispose();
    this.scene?.dispose();
    this.engine?.dispose();
  }
}

