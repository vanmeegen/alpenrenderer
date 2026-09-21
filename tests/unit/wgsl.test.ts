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
