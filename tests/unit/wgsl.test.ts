/**
 * Build-time check for the WGSL shaders.
 *
 * WebGPU cannot run in the test environment, so this does the next best
 * thing: it puts the WGSL through Babylon's own preprocessor — the same code
 * path the engine uses to turn `attribute`/`uniform`/`varying` declarations
 * into bindings — and then parses the result. That catches the syntax and
 * declaration mistakes that would otherwise show up as a black screen on a
 * device. It does not type-check, and it cannot tell you the pipeline links.
 */
import { describe, expect, test } from 'bun:test';
import { WgslReflect } from 'wgsl_reflect';
import { Finalize, Initialize, Process } from '@babylonjs/core/Engines/Processors/shaderProcessor.js';
import { WebGPUShaderProcessorWGSL } from '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessorsWGSL.js';
import { WebGPUShaderProcessingContext } from '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessingContext.js';
import * as S from '../../src/engine/render/gpu/wgsl';

function makeProcessor(context: WebGPUShaderProcessingContext) {
  const processor = new WebGPUShaderProcessorWGSL();
  processor.pureMode = false;
  processor.shaderLanguage = 1;
  processor.initializeShaders?.(context);
  (processor as unknown as { _webgpuProcessingContext: unknown })._webgpuProcessingContext = context;
  return processor;
}

const engineStub = {
  isWebGPU: true,
  _features: { needShaderCodeInlining: true },
  inlineShaderCode: (c: string) => c,
  getCaps: () => ({
    supportFloatTexturesResolve: false, textureFloatLinearFiltering: false,
    maxTextureSize: 8192, parallelShaderCompile: undefined,
  }),
};

function process(code: string, isFragment: boolean, context: WebGPUShaderProcessingContext,
  processor: WebGPUShaderProcessorWGSL): Promise<string> {
  const options = {
    defines: [] as string[], indexParameters: undefined, isFragment,
    shouldUseHighPrecisionShader: true, processor, supportsUniformBuffers: true,
    shadersRepository: '', includesShadersStore: {}, version: '450', platformName: 'WEBGPU',
    processingContext: context, isNDCHalfZRange: true, useReverseDepthBuffer: false,
    vertexBufferKindToNumberOfComponents: {},
  };
  Initialize?.(options as never);
  return new Promise((res, rej) => {
    try {
      Process(code, options as never, (out: string) => res(out), engineStub as never);
    } catch (e) { rej(e); }
  });
}

async function finalize(vsSrc: string, fsSrc: string) {
  const ctx = new WebGPUShaderProcessingContext(1, false);
  const processor = makeProcessor(ctx);
  const vs = await process(vsSrc, false, ctx, processor);
  const fs = await process(fsSrc, true, ctx, processor);
  const fin = Finalize(vs, fs, {
    processor, supportsUniformBuffers: true, isFragment: false,
    shouldUseHighPrecisionShader: true, defines: [], version: '450', platformName: 'WEBGPU',
    processingContext: ctx, isNDCHalfZRange: true, useReverseDepthBuffer: false,
    vertexBufferKindToNumberOfComponents: {},
  } as never);
  return { vs: fin.vertexCode, fs: fin.fragmentCode };
}

const pairs: [string, string, string, readonly string[]][] = [
  ['terrain', S.TERRAIN_VERTEX, S.TERRAIN_FRAGMENT, S.TERRAIN_UNIFORMS],
  ['shade', S.TERRAIN_VERTEX, S.TERRAIN_SHADE_FRAGMENT, S.SHADE_UNIFORMS],
  ['composite', S.COMPOSITE_VERTEX, S.COMPOSITE_FRAGMENT, S.COMPOSITE_UNIFORMS],
];

describe.each(pairs)('WGSL pair %s', (_name, vsSrc, fsSrc, expectUniforms) => {
  test('preprocesses, parses, and every uniform reaches the generated struct', async () => {
    const { vs, fs } = await finalize(vsSrc, fsSrc);
    for (const code of [vs, fs]) {
      const r = new WgslReflect(code);
      const entries = [...r.entry.vertex, ...r.entry.fragment];
      expect(entries.length).toBeGreaterThan(0);
    }
    const both = vs + '\n' + fs;
    const bind = /var<uniform>\s+uniforms\s*:\s*(\w+)\s*;/.exec(both);
    expect(bind).not.toBeNull();
    const struct = new RegExp(`struct\\s+${bind![1]}\\s*\\{([\\s\\S]*?)\\}`).exec(both);
    expect(struct).not.toBeNull();
    const members = new Set([...struct![1].matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]));
    const missing = expectUniforms.filter((u) => !members.has(u));
    expect(missing).toEqual([]);
    // A bare reference means a stripped declaration and an undeclared identifier.
    const body = both.replace(/struct\s+\w+\s*\{[\s\S]*?\}/g, '');
    for (const u of expectUniforms) {
      const bare = new RegExp(`(?<![\\w.])${u}(?![\\w])`, 'g');
      expect(bare.test(body)).toBe(false);
    }
  });
});

describe('shader dialect parity', () => {
  test('the GLSL fetches atlas texels by integer coordinate through a highp sampler', async () => {
    // On Apple GPUs a sampler2D without a precision qualifier is lowp, and
    // WebKit's Metal backend samples it at that precision: the normalised v
    // coordinate of a 640×5120 atlas then snaps to 1/256, twenty rows at a
    // time, and the terrain comes out as vertical bands (iPad, Safari, 2026).
    // Integer texel fetches carry no such coordinate, and the sampler is
    // declared highp so the fetched bytes come back whole.
    const GL = await import('../../src/engine/render/gpu/glsl');
    for (const src of [GL.TERRAIN_VERTEX_GL, GL.TERRAIN_SHADE_FRAGMENT_GL]) {
      expect(src).toContain('precision highp sampler2D;');
      expect(src).toContain('texelFetch(heights,');
      expect(src).not.toContain('textureLod(heights');
    }
    // The composite samples the range and colour buffers at screen resolution, 1/1640 apart.
    expect(GL.COMPOSITE_FRAGMENT_GL).toContain('precision highp sampler2D;');
  });

  test('both dialects paint water where the atlas\'s blue channel marks it', async () => {
    // The water mask rides in the atlas's spare channel (renderer.ts packs
    // it); the shade pass reads it at the cell and mixes in uWaterColor.
    const GL = await import('../../src/engine/render/gpu/glsl');
    expect(S.SHADE_UNIFORMS).toContain('uWaterColor');
    for (const src of [GL.TERRAIN_SHADE_FRAGMENT_GL, S.TERRAIN_SHADE_FRAGMENT]) {
      expect(src).toMatch(/fn waterAt|float waterAt/);
      expect(src).toContain('.b');
      expect(src).toContain('uWaterColor');
    }
  });

  test('both dialects put the same shine on the water, with the constants from shading.ts', async () => {
    // Fresnel toward the sky and a sun glint, computed from the view vector
    // the pass already has: no texture fetch, no extra pass.
    const GL = await import('../../src/engine/render/gpu/glsl');
    const { WATER_SHINE } = await import('../../src/engine/render/shading');
    for (const src of [GL.TERRAIN_SHADE_FRAGMENT_GL, S.TERRAIN_SHADE_FRAGMENT]) {
      expect(src).toMatch(/fn waterShine|vec3 waterShine/);
      expect(src).toContain(WATER_SHINE.f0.toFixed(3));
      expect(src).toContain(WATER_SHINE.sky.toFixed(3));
      expect(src).toContain(WATER_SHINE.glint.toFixed(3));
      expect(src).toContain(WATER_SHINE.sharpness.toFixed(1));
    }
  });

  test('both dialects draw the ink line and the haze rim with the constants from outline.ts', async () => {
    // One operator, three places: outline.ts (the mirror the unit tests
    // compute with) and the composite pass in each dialect.
    const GL = await import('../../src/engine/render/gpu/glsl');
    const { OUTLINE } = await import('../../src/engine/render/outline');
    const { shaderFloat } = await import('../../src/engine/render/gpu/consts');
    expect(S.COMPOSITE_UNIFORMS).toContain('uRim');
    expect(S.COMPOSITE_UNIFORMS).not.toContain('uEdgeLow');
    for (const src of [GL.COMPOSITE_FRAGMENT_GL, S.COMPOSITE_FRAGMENT]) {
      for (const [name, value] of [
        ['SIL_LOW', OUTLINE.silLow], ['SIL_HIGH', OUTLINE.silHigh], ['KAPPA', OUTLINE.kappa],
        ['W_FAR', OUTLINE.widthFar], ['W_NEAR', OUTLINE.widthNear], ['LOG_NEAR', OUTLINE.logNear], ['LOG_FAR', OUTLINE.logFar],
        ['INK_HAZE', OUTLINE.inkHaze], ['INK_FOG', OUTLINE.inkFog], ['STRENGTH_FAR', OUTLINE.strengthFar],
        ['RIM_R', OUTLINE.rimRadius], ['RIM_LOW', OUTLINE.rimLow], ['RIM_HIGH', OUTLINE.rimHigh], ['RIM_TAPS', OUTLINE.rimTaps], ['RIM_SKY', OUTLINE.rimSky],
        ['LOG_SKY', OUTLINE.logSky],
      ] as [string, number][]) {
        expect(src).toMatch(new RegExp(`const (float )?${name}\\b[^;]*= ${shaderFloat(value).replace('.', '\\.')};`));
      }
      expect(src).toContain(OUTLINE.ink.map(shaderFloat).join(', '));
      expect(src).toMatch(/fn sil\(|float sil\(/);
    }
  });

  test('both dialects haze and colour the ground with the constants from shading.ts', async () => {
    const GL = await import('../../src/engine/render/gpu/glsl');
    const { FOG, GROUND } = await import('../../src/engine/render/shading');
    const { shaderFloat } = await import('../../src/engine/render/gpu/consts');
    for (const src of [GL.TERRAIN_SHADE_FRAGMENT_GL, S.TERRAIN_SHADE_FRAGMENT]) {
      for (const [name, value] of [
        ['FOG_H', FOG.height], ['FOG_FLOOR', FOG.floor],
        ['ROCK_LOW', GROUND.rockLow], ['ROCK_HIGH', GROUND.rockHigh], ['ROCK_BELOW', GROUND.rockBelow], ['ROCK_ABOVE', GROUND.rockAbove],
        ['ROCK_FROM', GROUND.rockFrom], ['ROCK_TO', GROUND.rockTo], ['SNOW_LOW', GROUND.snowLow], ['SNOW_HIGH', GROUND.snowHigh],
      ] as [string, number][]) {
        expect(src).toMatch(new RegExp(`const (float )?${name}\\b[^;]*= ${shaderFloat(value).replace('.', '\\.')};`));
      }
      expect(src).toContain(FOG.beta.map(shaderFloat).join(', '));
      expect(src).toContain('uEyeAlt');
    }
  });

  test('the GLSL file declares the same uniform names as the WGSL lists', async () => {
    const GL = await import('../../src/engine/render/gpu/glsl');
    const declared = (src: string) => new Set([...src.matchAll(/uniform\s+\w+\s+(\w+)/g)].map((m) => m[1]));
    const terrain = declared(GL.TERRAIN_VERTEX_GL);
    for (const u of S.TERRAIN_UNIFORMS) expect(terrain.has(u)).toBe(true);
    const shade = new Set([...declared(GL.TERRAIN_VERTEX_GL), ...declared(GL.TERRAIN_SHADE_FRAGMENT_GL)]);
    for (const u of S.SHADE_UNIFORMS) expect(shade.has(u)).toBe(true);
    const composite = declared(GL.COMPOSITE_FRAGMENT_GL);
    for (const u of S.COMPOSITE_UNIFORMS) expect(composite.has(u)).toBe(true);
  });
});

describe('the height atlas', () => {
  test('both dialects find a level by column and row, the column count from atlas.ts', async () => {
    // One column of ten 640 px levels was a texture 6400 px tall; a phone
    // whose limit is 4096 drew nothing.
    const GL = await import('../../src/engine/render/gpu/glsl');
    const { ATLAS_COLUMNS } = await import('../../src/engine/render/atlas');
    const { shaderFloat } = await import('../../src/engine/render/gpu/consts');
    for (const src of [GL.TERRAIN_VERTEX_GL, GL.TERRAIN_SHADE_FRAGMENT_GL, S.TERRAIN_VERTEX, S.TERRAIN_SHADE_FRAGMENT]) {
      expect(src).toMatch(new RegExp(`const (float )?ATLAS_COLS\\b[^;]*= ${shaderFloat(ATLAS_COLUMNS).replace('.', '\\.')};`));
      expect(src).toMatch(/atlasOrigin\(/);
      expect(src).not.toMatch(/(float|f32)\(lv\) \* (uniforms\.)?uLevelPx/);   // the single column
    }
  });
});

describe('the surface atlas', () => {
  test('both dialects take normal and occlusion from the surface atlas, between its posts, and no longer one normal per cell', async () => {
    // core/surface.ts works both out per post; the shade pass reads the four
    // posts round a pixel and blends them, so a face is one surface. The
    // strength of the occlusion comes from the same constant shading.ts uses.
    const GL = await import('../../src/engine/render/gpu/glsl');
    const { SURFACE } = await import('../../src/engine/core/surface');
    const { shaderFloat } = await import('../../src/engine/render/gpu/consts');
    for (const src of [GL.TERRAIN_SHADE_FRAGMENT_GL, S.TERRAIN_SHADE_FRAGMENT]) {
      expect(src).toMatch(/fn surfaceAt\(|vec3 surfaceAt\(/);
      expect(src).not.toMatch(/gradientAt\(|fn gradient\(/);
      expect(src).toMatch(new RegExp(`const (float )?AO\\b[^;]*= ${shaderFloat(SURFACE.strength).replace('.', '\\.')};`));
    }
    // Exact texels in the GLSL, for the reason the heights are fetched so.
    expect(GL.TERRAIN_SHADE_FRAGMENT_GL).toContain('uniform sampler2D surface;');
    expect(GL.TERRAIN_SHADE_FRAGMENT_GL).toContain('texelFetch(surface,');
    expect(S.TERRAIN_SHADE_FRAGMENT).toContain('var surface ');
    // The range pass and the vertex stage have no use for it.
    expect(GL.TERRAIN_VERTEX_GL).not.toContain('surface');
    expect(S.TERRAIN_VERTEX).not.toContain('surface');
  });
});

describe('shader text Babylon can take apart', () => {
  test('no comment behind code holds a semicolon: the preprocessor cuts declarations there', async () => {
    // "uniform float uRim;   // …; 0 = off" compiled to a lone "0 = off" and a black screen (WebGL2).
    const G = await import('../../src/engine/render/gpu/glsl');
    const sources: Record<string, string> = {
      ...Object.fromEntries(Object.entries(G).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
      ...Object.fromEntries(Object.entries(S).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
    };
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(10);
    const bad: string[] = [];
    for (const [name, src] of Object.entries(sources)) {
      for (const line of src.split('\n')) {
        const at = line.indexOf('//');
        if (at > 0 && line.slice(0, at).trim() !== '' && line.slice(at).includes(';')) bad.push(`${name}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
