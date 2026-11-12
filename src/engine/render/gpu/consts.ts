/**
 * Constants written into the shader text of both dialects from the one
 * TypeScript source (outline.ts, shading.ts), so that the formula a test
 * computes and what the GPU draws cannot drift apart.
 */
import { OUTLINE } from '../outline';
import { FOG, GROUND } from '../shading';
import { SURFACE } from '../../core/surface';
import { DETAIL } from '../detail';

/** A number as a float literal both GLSL and WGSL accept. */
export const shaderFloat = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

type Const = [name: string, value: number | readonly number[]];

/** The composite pass: ink line and haze rim. */
export const OUTLINE_CONSTS: Const[] = [
  ['SIL_LOW', OUTLINE.silLow], ['SIL_HIGH', OUTLINE.silHigh], ['KAPPA', OUTLINE.kappa],
  ['W_FAR', OUTLINE.widthFar], ['W_NEAR', OUTLINE.widthNear], ['LOG_NEAR', OUTLINE.logNear], ['LOG_FAR', OUTLINE.logFar],
  ['INK', OUTLINE.ink], ['INK_HAZE', OUTLINE.inkHaze], ['INK_FOG', OUTLINE.inkFog], ['STRENGTH_FAR', OUTLINE.strengthFar],
  ['RIM_R', OUTLINE.rimRadius], ['RIM_LOW', OUTLINE.rimLow], ['RIM_HIGH', OUTLINE.rimHigh], ['RIM_TAPS', OUTLINE.rimTaps], ['RIM_SKY', OUTLINE.rimSky],
  ['LOG_SKY', OUTLINE.logSky], ['RING_S', Math.SQRT1_2],
];

/** The shade pass: the air and what the ground is made of. */
export const SHADE_CONSTS: Const[] = [
  ['FOG_H', FOG.height], ['FOG_FLOOR', FOG.floor], ['FOG_BETA', FOG.beta],
  ['ROCK_LOW', GROUND.rockLow], ['ROCK_HIGH', GROUND.rockHigh], ['ROCK_BELOW', GROUND.rockBelow], ['ROCK_ABOVE', GROUND.rockAbove],
  ['ROCK_FROM', GROUND.rockFrom], ['ROCK_TO', GROUND.rockTo], ['SNOW_LOW', GROUND.snowLow], ['SNOW_HIGH', GROUND.snowHigh],
  ['AO', SURFACE.strength],
  ['DETAIL_GRAIN', DETAIL.grain], ['DETAIL_TILT', DETAIL.tilt], ['DETAIL_NEAR', DETAIL.near], ['DETAIL_FAR', DETAIL.far],
  ['DETAIL_FINER', DETAIL.finer], ['DETAIL_FINEST', DETAIL.finest],
];

export const glslConsts = (list: Const[]): string => list.map(([n, v]) => (typeof v === 'number'
  ? `const float ${n} = ${shaderFloat(v)};`
  : `const vec3 ${n} = vec3(${v.map(shaderFloat).join(', ')});`)).join('\n');

export const wgslConsts = (list: Const[]): string => list.map(([n, v]) => (typeof v === 'number'
  ? `const ${n} : f32 = ${shaderFloat(v)};`
  : `const ${n} : vec3<f32> = vec3<f32>(${v.map(shaderFloat).join(', ')});`)).join('\n');
