/**
 * The same three passes in GLSL, for the WebGL2 backend.
 *
 * This exists to be debuggable and to run everywhere. A software WebGPU
 * adapter is unstable enough in headless containers that it cannot be used to
 * check whether the renderer draws the right picture; WebGL2 runs anywhere,
 * including under SwiftShader in CI, so a known view can be rendered and the
 * pixels looked at. It is also the path every phone and tablet has today.
 *
 * Everything here is a line-for-line translation of wgsl.ts and must stay one.
 * The uniform names, the packing and the geometry are shared verbatim; only the
 * dialect and two conventions differ:
 *
 *   - Depth. WebGL clips z to [-1,1] where WebGPU uses [0,1], so the
 *     logarithmic remap ends on a different interval. Camera.depthZeroToOne
 *     handles the projection matrix; this handles the remap that follows it.
 *   - Samplers. GLSL combines texture and sampler into one `sampler2D`, so
 *     there is no `xxxSampler` companion to declare.
 *
 * Babylon's WebGL2 processor rewrites `attribute` to `in`, `varying` to
 * `in`/`out`, `texture2D(` to `texture(` and `gl_FragColor` to a declared
 * output. Writing the older spelling is therefore the idiomatic thing to do
 * here, and `textureLod` — which it does not rewrite outside fragment shaders —
 * is already valid GLSL ES 3.00 and passes through untouched.
 */

import { WATER_SHINE } from '../shading';
import { OUTLINE_CONSTS, SHADE_CONSTS, glslConsts, shaderFloat } from './consts';
import { ATLAS_COLUMNS, MAX_LEVELS } from '../atlas';

/** Water shine constants, written into the shader text so formula and GPU cannot drift apart. */
const F0 = WATER_SHINE.f0.toFixed(3);
const SKY = WATER_SHINE.sky.toFixed(3);
const GLINT = WATER_SHINE.glint.toFixed(3);
const SHARP = WATER_SHINE.sharpness.toFixed(1);

/** Range packing. Byte-for-byte identical to the WGSL in wgsl.ts. */
const RANGE_CODEC = /* glsl */ `
const float RANGE_MIN = 8.0;
const float LOG_MIN   = 2.0794415;
const float LOG_SPAN  = 10.8198;      // log(4.0e5) - log(8)

vec4 packRange(float range, float hit) {
  float t = clamp((log(max(range, RANGE_MIN)) - LOG_MIN) / LOG_SPAN, 0.0, 1.0);
  float v = t * 16777215.0;
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  return vec4(r / 255.0, g / 255.0, b / 255.0, hit);
}

float unpackLogRange(vec4 p) {
  float v = floor(p.r * 255.0 + 0.5) * 65536.0
          + floor(p.g * 255.0 + 0.5) * 256.0
          + floor(p.b * 255.0 + 0.5);
  return LOG_MIN + (v / 16777215.0) * LOG_SPAN;
}
`;

/** Clipmap sampling shared by the vertex stage and the shade fragment stage. */
const CLIPMAP_SAMPLER = /* glsl */ `
/**
 * One exact texel out of the stacked clipmap atlas. Fetched by integer
 * coordinate, not sampled at a normalised one: WebKit's Metal backend samples
 * at the sampler's precision, and a 640×5120 atlas needs more than the
 * mediump a phone or tablet gives a texture coordinate. Sampled, the rows
 * snapped twenty at a time and the terrain came out as vertical bands
 * (iPad, Safari, 2026). The WGSL keeps its normalised sample; WebGPU has no
 * reduced precision to lose.
 */
const float ATLAS_COLS = ${shaderFloat(ATLAS_COLUMNS)};

/** Top-left texel of a level in the atlas: the levels lie ATLAS_COLS abreast (render/atlas.ts). */
vec2 atlasOrigin(int lv) {
  float row = floor(float(lv) / ATLAS_COLS);
  return vec2(float(lv) - row * ATLAS_COLS, row) * uLevelPx;
}

float texel(int lv, float x, float y) {
  vec2 o = atlasOrigin(lv);
  float px = clamp(x, 0.0, uLevelPx - 1.0) + o.x;
  float py = clamp(y, 0.0, uLevelPx - 1.0) + o.y;
  vec4 c = texelFetch(heights, ivec2(int(px), int(py)), 0);
  return floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5);
}

float sampleLevel(int lv, float dLon, float dIso) {
  vec4 A = uLvlA[lv];
  vec4 B = uLvlB[lv];
  float u = A.x + dLon * A.z;
  float v = A.y - dIso * A.z;
  vec2 f = vec2(u, v) - vec2(0.5, 0.5);   // raster pixels are area samples
  vec2 p0 = floor(f);
  vec2 t = f - p0;
  float h00 = texel(lv, p0.x, p0.y);
  float h10 = texel(lv, p0.x + 1.0, p0.y);
  float h01 = texel(lv, p0.x, p0.y + 1.0);
  float h11 = texel(lv, p0.x + 1.0, p0.y + 1.0);
  float h = mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
  return h * B.x + B.y;
}

/** Finest observer level that still covers a ground range (a look level, flagged < 0, never). */
int levelFor(float r) {
  int lv = int(uLevelCount) - 1;
  for (int i = 0; i < ${MAX_LEVELS}; i++) {
    if (float(i) >= uLevelCount) { break; }
    float reach = uLvlA[i].w;
    if (reach > 0.0 && r <= reach) { lv = i; break; }
  }
  // The coarsest observer level, not a look level, as the last resort.
  if (uLvlA[lv].w < 0.0) { for (int i = ${MAX_LEVELS - 1}; i >= 0; i--) { if (float(i) < uLevelCount && uLvlA[i].w > 0.0) { lv = i; break; } } }
  return lv;
}

/**
 * The telescope's window this point lies in (finest first), or -1. A look
 * level is cut around the point looked at, not the observer, so it is taken
 * by position: inside the window with room for the bilinear taps.
 */
int lookLevel(float dLon, float dIso) {
  for (int i = 0; i < ${MAX_LEVELS}; i++) {
    if (float(i) >= uLevelCount) { break; }
    if (uLvlA[i].w >= 0.0) { continue; }
    vec4 A = uLvlA[i];
    vec4 B = uLvlB[i];
    float u = A.x + dLon * A.z;
    float v = A.y - dIso * A.z;
    if (u > 1.5 && u < B.z - 2.5 && v > 1.5 && v < B.w - 2.5) { return i; }
  }
  return -1;
}

/** 0 well inside a look window, 1 at its edge: the blend back into the observer's levels. */
float lookFade(int lk, float dLon, float dIso) {
  vec4 A = uLvlA[lk];
  vec4 B = uLvlB[lk];
  float u = A.x + dLon * A.z;
  float v = A.y - dIso * A.z;
  float d = max(abs(u - 0.5 * B.z) / (0.5 * B.z), abs(v - 0.5 * B.w) / (0.5 * B.w));
  return smoothstep(0.80, 0.95, d);
}
`;

const VARYINGS = /* glsl */ `
varying float vRange;
varying float vDLon;
varying float vDIso;
varying float vH;
`;

export const TERRAIN_VERTEX_GL = /* glsl */ `
precision highp float;
precision highp sampler2D;
// x = azimuth index, y = radial row index. Everything else is derived.
attribute vec3 position;

uniform float uAz0;         // bearing of column 0 (the wedge over the view)
uniform float uAzStep;
uniform vec4  uRadial;      // jNear, logRatioNear, jSplit, logRatioFar
uniform vec4  uRadialB;     // r0, rNearEnd, stepMid, rSplit
uniform float uSinLat0;
uniform float uCosLat0;
uniform float uEyeAlt;
uniform float uRadius;
uniform float uRefRadius;
uniform float uDropScale;
uniform float uLevelCount;
uniform vec2  uTexSize;
uniform float uLevelPx;     // pixels per clipmap level in the stacked atlas
uniform mat4  uViewProj;
uniform float uFar;
uniform vec4  uLvlA[${MAX_LEVELS}];    // cx, cy, pxPerRad, maxRange (< 0: a look level, taken by position)
uniform vec4  uLvlB[${MAX_LEVELS}];    // quant, bias, w, h

uniform sampler2D heights;

${VARYINGS}

/**
 * log(1+x) without the cancellation. |x| stays well under 0.12 for the ranges
 * this renderer covers, where six terms are good to about 4e-7.
 */
float log1p(float x) {
  return x * (1.0 - x * (0.5 - x * (0.3333333 - x * (0.25 - x * (0.2 - x * 0.1666667)))));
}

/**
 * Sample spacing along a ray, in three segments: geometric near, so the ground
 * at your feet is not one enormous triangle; one DEM post per step through the
 * middle; geometric again far out, tracking the angular step so screen-space
 * triangle size stays roughly constant to the far plane.
 */
float radiusAt(float f) {
  if (f < uRadial.x) { return uRadialB.x * exp(f * uRadial.y); }
  if (f < uRadial.z) { return uRadialB.y + (f - uRadial.x) * uRadialB.z; }
  return uRadialB.w * exp((f - uRadial.z) * uRadial.w);
}

${CLIPMAP_SAMPLER}

void main(void) {
  float alpha = uAz0 + position.x * uAzStep;
  float r = radiusAt(position.y);
  float sinA = sin(alpha);
  float cosA = cos(alpha);

  // Great-circle destination at bearing alpha, ground range r — kept entirely
  // in offsets from the observer. Forming sin(lat) and then subtracting
  // sin(lat0), or forming the isometric latitude and subtracting the
  // observer's, cancels two f32 values near 0.93 and then multiplies the
  // wreckage by ~1.7e5 pixels per radian.
  float delta = r / uRadius;
  float sinD = sin(delta);
  float cosD = cos(delta);
  float hs = sin(0.5 * delta);
  float hav = hs * hs;
  float ds = uCosLat0 * sinD * cosA - 2.0 * uSinLat0 * hav;   // sin(lat) - sin(lat0)
  float sinP = clamp(uSinLat0 + ds, -1.0, 1.0);
  float dLon = atan(sinA * sinD * uCosLat0, cosD - uSinLat0 * sinP);
  // d/dphi of the isometric latitude is sec(phi); in terms of s = sin(phi) the
  // integral is 0.5*log((1+s)/(1-s)), so the offset falls out of ds alone.
  float dIso = 0.5 * (log1p(ds / (1.0 + uSinLat0)) - log1p(-ds / (1.0 - uSinLat0)));

  // Finest level that still covers this range, cross-faded into the next so an
  // LOD change never shows up as a step in the skyline.
  int lv = levelFor(r);
  float h = sampleLevel(lv, dLon, dIso);
  if (float(lv) + 1.0 < uLevelCount && uLvlA[lv + 1].w > 0.0) {
    float outer = uLvlA[lv].w;
    float fade = smoothstep(outer * 0.86, outer, r);
    if (fade > 0.0) { h = mix(h, sampleLevel(lv + 1, dLon, dIso), fade); }
  }
  // Inside the telescope's window its finer posts take over, blended out at the window's edge.
  int lk = lookLevel(dLon, dIso);
  if (lk >= 0) { h = mix(sampleLevel(lk, dLon, dIso), h, lookFade(lk, dLon, dIso)); }

  float horiz = (uRadius + h) * sinD;
  float s = sin(r / (2.0 * uRefRadius));
  float drop = 2.0 * (uRefRadius + h) * s * s * uDropScale;

  vec3 enu = vec3(horiz * sinA, horiz * cosA, (h - uEyeAlt) - drop);
  vRange = length(enu);
  vDLon = dLon;
  vDIso = dIso;
  vH = h;

  vec4 clip = uViewProj * vec4(enu, 1.0);
  // Logarithmic depth. Same curve as the WGSL, mapped to WebGL's [-1,1] clip
  // range instead of WebGPU's [0,1]. One 24-bit buffer has to separate a
  // boulder three metres away from a ridge 270 km away.
  clip.z = (2.0 * log2(max(1e-6, 1.0 + clip.w)) / log2(1.0 + uFar) - 1.0) * clip.w;
  gl_Position = clip;
}
`;

export const TERRAIN_FRAGMENT_GL = /* glsl */ `
precision highp float;
${VARYINGS}
${RANGE_CODEC}

void main(void) {
  gl_FragColor = packRange(vRange, 1.0);
}
`;

/** Shaded terrain; see TERRAIN_SHADE_FRAGMENT in wgsl.ts for the reasoning. */
export const TERRAIN_SHADE_FRAGMENT_GL = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${VARYINGS}

uniform float uLevelCount;
uniform vec2  uTexSize;
uniform float uLevelPx;
uniform float uRadius;
uniform float uCosLat0;
uniform vec4  uLvlA[${MAX_LEVELS}];
uniform vec4  uLvlB[${MAX_LEVELS}];
uniform vec3  uSun;          // towards the sun, ENU, unit
uniform float uSnowLine;     // metres
uniform float uFogRange;     // metres to 1/e of the terrain colour
uniform vec3  uHorizonColor;
uniform vec3  uWaterColor;   // lakes, where the atlas's blue channel says so
uniform float uEyeAlt;
uniform float uRefRadius;
uniform float uDropScale;

uniform vec3  uDetail;        // the grain of the near ground: tiles per radian fine and coarse, strength (0 = off)
uniform vec4  uDetailOrigin;  // the standpoint's place in a tile, fine (xy) and coarse (zw)

uniform vec4  uImagery;       // the aerial picture: 1 when the style shows it, its pixels per level side, its atlas's width and height

uniform sampler2D heights;
uniform sampler2D surface;
uniform sampler2D detail;
uniform sampler2D imagery;

${glslConsts(SHADE_CONSTS)}

${CLIPMAP_SAMPLER}

/**
 * Normal and occlusion at one level, as the surface atlas packs them
 * (core/surface.ts): x, y the east and north of the unit normal as c/2 + 1/2,
 * z the occlusion. Worked out per post on the CPU and blended here between
 * the four posts round the point, so a face is one surface. The old way, a
 * central difference at the cell the point falls in, gave one normal per
 * cell: zoomed in, every post was a square of its own shade. Fetched as
 * exact texels and blended by hand, for the reason the heights are.
 */
vec3 surfaceTexel(int lv, float x, float y) {
  vec2 o = atlasOrigin(lv);
  float px = clamp(x, 0.0, uLevelPx - 1.0) + o.x;
  float py = clamp(y, 0.0, uLevelPx - 1.0) + o.y;
  return texelFetch(surface, ivec2(int(px), int(py)), 0).rgb;
}

vec3 surfaceAt(int lv, float dLon, float dIso) {
  vec4 A = uLvlA[lv];
  vec2 f = vec2(A.x + dLon * A.z, A.y - dIso * A.z) - vec2(0.5, 0.5);
  vec2 p0 = floor(f);
  vec2 t = f - p0;
  vec3 s00 = surfaceTexel(lv, p0.x, p0.y);
  vec3 s10 = surfaceTexel(lv, p0.x + 1.0, p0.y);
  vec3 s01 = surfaceTexel(lv, p0.x, p0.y + 1.0);
  vec3 s11 = surfaceTexel(lv, p0.x + 1.0, p0.y + 1.0);
  return mix(mix(s00, s10, t.x), mix(s01, s11, t.x), t.y);
}

/**
 * 1 where the lake mask marks the DEM post this point falls on, 0 on dry
 * ground: the atlas's blue channel, burnt in from the lake catalogue.
 */
float waterAt(int lv, float dLon, float dIso) {
  vec4 A = uLvlA[lv];
  vec2 o = atlasOrigin(lv);
  float px = clamp(floor(A.x + dLon * A.z), 0.0, uLevelPx - 1.0) + o.x;
  float py = clamp(floor(A.y - dIso * A.z), 0.0, uLevelPx - 1.0) + o.y;
  return step(0.5, texelFetch(heights, ivec2(int(px), int(py)), 0).b);
}

/**
 * The land cover class (render/shading.ts COVER_CLASSES, 0 = none) of the
 * DEM post at this point moved jit metres east and north: the atlas's
 * alpha channel, sixteen to the class.
 */
float coverAt(int lv, float dLon, float dIso, vec2 jit) {
  vec4 A = uLvlA[lv];
  vec2 o = atlasOrigin(lv);
  float perMetre = A.z / (uRadius * uCosLat0);
  float px = clamp(floor(A.x + dLon * A.z + jit.x * perMetre), 0.0, uLevelPx - 1.0) + o.x;
  float py = clamp(floor(A.y - dIso * A.z - jit.y * perMetre), 0.0, uLevelPx - 1.0) + o.y;
  return floor(texelFetch(heights, ivec2(int(px), int(py)), 0).a * 255.0 / 16.0 + 0.5);
}

/**
 * The aerial picture at one level (sources/imagery.ts): its colour, and in
 * alpha whether a tile gave one. The picture's cells lie in their atlas as
 * the levels do in theirs, at their own size. Read between its pixels by
 * the sampler, kept half a pixel inside the cell so the neighbour's does
 * not bleed in.
 */
vec4 imageryAt(int lv, float dLon, float dIso) {
  vec4 A = uLvlA[lv];
  float cell = uImagery.y;
  vec2 p = vec2(A.x + dLon * A.z, A.y - dIso * A.z) * (cell / uLevelPx);
  p = clamp(p, vec2(0.5, 0.5), vec2(cell - 0.5, cell - 0.5));
  float row = floor(float(lv) / ATLAS_COLS);
  vec2 o = vec2(float(lv) - row * ATLAS_COLS, row) * cell;
  return textureLod(imagery, (o + p) / uImagery.zw, 0.0);
}

/** The ground's own colour for a class at height h, or none (the height's tint) where there is no class. */
vec3 coverColor(float c, float h, vec3 none) {
  if (c < 0.5) { return none; }
  if (c < 1.5) { return COVER_TREE; }
  if (c < 2.5) { return COVER_SHRUB; }
  if (c < 3.5) { return mix(COVER_GRASS_LOW, COVER_GRASS_HIGH, smoothstep(GRASS_FROM, GRASS_TO, h)); }
  if (c < 4.5) { return COVER_CROP; }
  if (c < 5.5) { return COVER_BUILT; }
  if (c < 6.5) { return COVER_BARE; }
  if (c < 7.5) { return COVER_SNOW; }
  if (c < 8.5) { return uWaterColor; }
  if (c < 9.5) { return COVER_WETLAND; }
  if (c < 10.5) { return COVER_TREE; }
  if (c < 11.5) { return COVER_MOSS; }
  return none;
}

/**
 * Unit vector from the eye to this point, east-north-up, from what the pass
 * already has: the horizontal direction from the offsets (Mercator is
 * conformal, so east and north scale alike), the vertical from the height
 * difference less the curvature drop the vertex stage applied.
 */
vec3 viewDir() {
  vec2 hz = vec2(vDLon, vDIso);
  float lh = length(hz);
  vec2 dirH = lh > 0.0 ? hz / lh : vec2(0.0, 1.0);
  float s = sin(vRange / (2.0 * uRefRadius));
  float drop = 2.0 * (uRefRadius + vH) * s * s * uDropScale;
  float vz = clamp(((vH - uEyeAlt) - drop) / max(vRange, 1.0), -1.0, 1.0);
  return vec3(dirH * sqrt(1.0 - vz * vz), vz);
}

/** A little sky (Fresnel) and a soft sun glint on flat water; see WATER_SHINE in shading.ts. */
vec3 waterShine(vec3 col, vec3 v) {
  float cosI = max(0.0, -v.z);
  float fresnel = ${F0} + (1.0 - ${F0}) * pow(1.0 - cosI, 5.0);
  col = mix(col, uHorizonColor, fresnel * ${SKY});
  float mirrored = max(0.0, dot(vec3(v.x, v.y, -v.z), uSun));
  return min(col + vec3(${GLINT} * pow(mirrored, ${SHARP})), vec3(1.0));
}

void main(void) {
  float r = vRange;
  float dLon = vDLon;
  float dIso = vDIso;
  float h = vH;

  // The grain of the near ground (render/detail.ts): slope east, slope north
  // and value of a small tiling noise at three sizes. Fixed to the ground by
  // the standpoint's place in a tile. Read before any branch, where the
  // sampler still has its derivatives for the mip.
  vec2 ground = vec2(dLon, dIso);
  vec2 fineUv = ground * uDetail.x + uDetailOrigin.xy;
  vec3 fineGrain = texture2D(detail, fineUv).rgb;
  vec3 coarseGrain = texture2D(detail, ground * uDetail.y + uDetailOrigin.zw).rgb;
  vec3 grain = fineGrain + coarseGrain - vec3(1.0)
             + DETAIL_FINEST * (2.0 * texture2D(detail, fineUv * DETAIL_FINER).rgb - vec3(1.0));
  // Where the land cover is read: moved by the grain, so the 106 m steps of its pixels fray.
  vec2 jit = COVER_JITTER * ((2.0 * coarseGrain.xy - vec2(1.0)) + 0.5 * (2.0 * fineGrain.xy - vec2(1.0)));

  int lv = levelFor(r);
  vec3 sf = surfaceAt(lv, dLon, dIso);
  float wet = waterAt(lv, dLon, dIso);
  float cover = coverAt(lv, dLon, dIso, jit);
  vec4 picture = vec4(0.0);
  if (uImagery.x > 0.5) { picture = imageryAt(lv, dLon, dIso); }
  if (float(lv) + 1.0 < uLevelCount && uLvlA[lv + 1].w > 0.0) {
    float outer = uLvlA[lv].w;
    float fade = smoothstep(outer * 0.86, outer, r);
    if (fade > 0.0) {
      sf = mix(sf, surfaceAt(lv + 1, dLon, dIso), fade);
      wet = mix(wet, waterAt(lv + 1, dLon, dIso), fade);
      if (fade > 0.5) { cover = coverAt(lv + 1, dLon, dIso, jit); }
      if (uImagery.x > 0.5) { picture = mix(picture, imageryAt(lv + 1, dLon, dIso), fade); }
    }
  }
  int lk = lookLevel(dLon, dIso);
  if (lk >= 0) {
    float lf = lookFade(lk, dLon, dIso);
    sf = mix(surfaceAt(lk, dLon, dIso), sf, lf);
    wet = mix(waterAt(lk, dLon, dIso), wet, lf);
  }
  vec2 nh = sf.xy * 2.0 - vec2(1.0, 1.0);
  vec3 n = normalize(vec3(nh, sqrt(max(1.0e-4, 1.0 - dot(nh, nh)))));
  float slope = 1.0 - n.z;               // 0 flat .. 1 vertical

  // Hypsometric tint with slope-dependent rock and snow.
  vec3 valley = vec3(0.47, 0.60, 0.33);
  vec3 forest = vec3(0.28, 0.43, 0.24);
  vec3 meadow = vec3(0.58, 0.60, 0.38);
  vec3 rock   = vec3(0.52, 0.50, 0.47);
  vec3 snow   = vec3(0.94, 0.96, 0.99);
  vec3 col = mix(valley, forest, smoothstep(700.0, 1100.0, h));
  col = mix(col, meadow, smoothstep(1500.0, 1900.0, h));
  col = mix(col, rock, smoothstep(1950.0, 2350.0, h));
  // Where a survey says what the ground is, that; rock and snow over it as ever.
  col = coverColor(cover, h, col);
  // Rock from 33° to 45°, weaker below the tree line; snow gone between 40° and 50° (shading.ts GROUND).
  float rocky = smoothstep(ROCK_LOW, ROCK_HIGH, slope)
              * mix(ROCK_BELOW, ROCK_ABOVE, smoothstep(ROCK_FROM, ROCK_TO, h));
  col = mix(col, rock, rocky);
  // Ground the survey knows and does not call ice keeps only a share of the height's snow.
  float known = step(0.5, cover) * step(cover, 11.5) * (1.0 - step(6.5, cover) * step(cover, 7.5));
  float snowy = smoothstep(uSnowLine - 350.0, uSnowLine + 50.0, h)
              * (1.0 - smoothstep(SNOW_LOW, SNOW_HIGH, slope)) * mix(1.0, SNOW_ON_LAND, known);
  col = mix(col, snow, snowy);
  col = mix(col, uWaterColor, wet);
  // The aerial style: where a tile gave a colour, the photograph is the ground.
  float aerial = picture.a * uImagery.x;
  col = mix(col, vec3(1.0) - pow(vec3(1.0) - picture.rgb, vec3(AERIAL_LIFT)), aerial);

  // Plain Lambert with a floor: shadow sides keep their shape, lit faces
  // stand out. A sky term that lifted north faces flattened the relief.
  // Times what the ground around leaves of the sky: gullies darker, ridges lighter.
  // Near the eye the grain bumps the normal the light sees and mottles the
  // brightness, on dry ground. What the ground is made of stays the smooth normal's.
  // A photograph has its own light, and a little grain of its own: the relief's at part strength over it.
  float grainy = uDetail.z * (1.0 - smoothstep(DETAIL_NEAR, DETAIL_FAR, r)) * (1.0 - wet) * mix(1.0, AERIAL_GRAIN, aerial);
  vec3 nl = normalize(vec3(n.xy - DETAIL_TILT * grainy * grain.xy, n.z));
  float diff = max(dot(nl, uSun), 0.0);
  float shade = (0.28 + 0.72 * diff) * (1.0 + AO * (2.0 * sf.z - 1.0)) * (1.0 + DETAIL_GRAIN * grainy * grain.z);
  shade = mix(shade, 1.0 + (shade - 1.0) * AERIAL_LIGHT, aerial);
  col = col * shade;
  if (wet > 0.0) { col = mix(col, waterShine(col, viewDir()), wet); }

  // Aerial perspective (shading.ts FOG): the air thins with altitude, so haze
  // lies in the valleys; blue goes first, so the distance turns blue; and a
  // floor is kept, so the farthest ridge is still a ridge.
  float dz = (h - uEyeAlt) / FOG_H;
  float air = abs(dz) < 1.0e-3 ? exp(-uEyeAlt / FOG_H) : (exp(-uEyeAlt / FOG_H) - exp(-h / FOG_H)) / dz;
  vec3 through = max(vec3(FOG_FLOOR), exp(-(r / uFogRange) * air * FOG_BETA));
  col = uHorizonColor + (col - uHorizonColor) * through;

  gl_FragColor = vec4(col, 1.0);
}
`;

export const COMPOSITE_VERTEX_GL = /* glsl */ `
attribute vec3 position;
varying vec2 vUV;

void main(void) {
  // A fullscreen quad in clip space; no camera is involved.
  vUV = position.xy * 0.5 + vec2(0.5, 0.5);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAGMENT_GL = /* glsl */ `
precision highp float;
precision highp sampler2D;
varying vec2 vUV;

uniform vec2  uTexel;
uniform float uEdgeWidth;   // device pixels per CSS pixel
uniform float uRim;         // strength of the haze rim behind ridges, 0 = off
uniform float uWhiten;   // how far the camera image is washed towards white
uniform float uDesat;
uniform float uHasVideo;
uniform vec2  uVideoScale;   // cover-crop of the video inside the canvas
uniform float uLineDark;
uniform float uShade;     // 1 = shaded 3D view, 0 = AR outline over the camera
uniform float uOutline;   // 0..1 strength of ridge lines in the shaded view
uniform vec3  uCamFwd;    // ENU view basis, for the sky gradient
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec2  uTanHalf;   // tan of half the horizontal / vertical fov
uniform vec3  uSkyTop;
uniform vec3  uHorizonColor;

uniform sampler2D rangeTex;
uniform sampler2D colorTex;
uniform sampler2D videoTex;

${RANGE_CODEC}

// The ink line and the haze rim: outline.ts, where the reasoning is.
${glslConsts(OUTLINE_CONSTS)}

/** Log range at a pixel; LOG_SKY ("beyond the far plane") where nothing is drawn, so the skyline is an edge too. */
float logAt(vec2 uv) {
  vec4 p = texture2D(rangeTex, uv);
  if (p.a > 0.5) { return unpackLogRange(p); }
  return LOG_SKY;
}

/** One axis of the ring: the second difference less a share of the smaller step. */
float sil(float a, float b) {
  return smoothstep(SIL_LOW, SIL_HIGH, a + b - KAPPA * min(abs(a), abs(b)));
}

/** One neighbour of the rim: how far it counts as standing in front, given its range less the surface continued to it. */
float inFront(float rho) {
  return smoothstep(RIM_LOW, RIM_HIGH, -rho);
}

void main(void) {
  vec2 uv = vUV;

  // --- silhouette ------------------------------------------------------
  float lc = logAt(uv);
  float nearby = 1.0 - smoothstep(LOG_NEAR, LOG_FAR, lc);
  float wpx = uEdgeWidth * mix(W_FAR, W_NEAR, nearby);   // line width, device pixels
  vec2 w = uTexel * wpx;
  vec2 wd = w * RING_S;
  float ax = logAt(uv + vec2(w.x, 0.0)) - lc;
  float bx = logAt(uv - vec2(w.x, 0.0)) - lc;
  float ay = logAt(uv + vec2(0.0, w.y)) - lc;
  float by = logAt(uv - vec2(0.0, w.y)) - lc;
  float ad = logAt(uv + wd) - lc;
  float bd = logAt(uv - wd) - lc;
  float ae = logAt(uv + vec2(wd.x, -wd.y)) - lc;
  float be = logAt(uv - vec2(wd.x, -wd.y)) - lc;
  float edge = clamp((sil(ax, bx) + sil(ay, by) + sil(ad, bd) + sil(ae, be)) * 0.5, 0.0, 1.0);

  if (uShade > 0.5) {
    // --- the shaded view ------------------------------------------------
    vec4 c = texture2D(colorTex, uv);
    // Sky by the elevation of the view ray through this pixel.
    vec2 ndc = uv * 2.0 - vec2(1.0, 1.0);
    vec3 dir = uCamFwd + uCamRight * (ndc.x * uTanHalf.x) + uCamUp * (ndc.y * uTanHalf.y);
    float elev = dir.z / length(dir);          // sin of the elevation angle
    vec3 sky = mix(uHorizonColor, uSkyTop, smoothstep(0.0, 0.5, elev));
    // Below the horizon with nothing drawn (past the far plane): dim ground.
    sky = mix(sky, uHorizonColor * 0.72, smoothstep(0.0, -0.15, elev));
    vec3 ground = mix(sky, c.rgb, c.a);

    // The haze rim: lighter right behind a nearer ridge, so the layers come apart.
    if (uRim > 0.0) {
      vec2 g = vec2(abs(ax) < abs(bx) ? ax : -bx, abs(ay) < abs(by) ? ay : -by) / wpx;
      float R = RIM_R * uEdgeWidth;
      vec2 r = uTexel * R;
      vec2 rd = r * RING_S;
      float gd = (g.x + g.y) * RING_S;
      float ge = (g.x - g.y) * RING_S;
      float count = inFront(logAt(uv + vec2(r.x, 0.0)) - (lc + R * g.x))
                  + inFront(logAt(uv - vec2(r.x, 0.0)) - (lc - R * g.x))
                  + inFront(logAt(uv + vec2(0.0, r.y)) - (lc + R * g.y))
                  + inFront(logAt(uv - vec2(0.0, r.y)) - (lc - R * g.y))
                  + inFront(logAt(uv + rd) - (lc + R * gd))
                  + inFront(logAt(uv - rd) - (lc - R * gd))
                  + inFront(logAt(uv + vec2(rd.x, -rd.y)) - (lc + R * ge))
                  + inFront(logAt(uv - vec2(rd.x, -rd.y)) - (lc - R * ge));
      float rim = uRim * min(1.0, count / RIM_TAPS) * mix(RIM_SKY, 1.0, c.a);
      ground = mix(ground, uHorizonColor, rim);
    }

    // The ink: mixed in, paling into the haze with distance, stronger close by.
    vec3 ink = mix(INK, uHorizonColor, INK_HAZE * (1.0 - exp(-exp(lc) / INK_FOG)));
    ground = mix(ground, ink, edge * uOutline * mix(STRENGTH_FAR, 1.0, nearby));
    gl_FragColor = vec4(ground, 1.0);
    return;
  }

  // --- the AR view: outline over the camera image -------------------------
  vec3 ground = vec3(1.0, 1.0, 1.0);
  if (uHasVideo > 0.5) {
    // The video is drawn cover-cropped, matching the CSS object-fit the
    // element would have used, so the overlay geometry lines up with it.
    vec2 cuv = (uv - vec2(0.5, 0.5)) * uVideoScale + vec2(0.5, 0.5);
    vec3 cam = texture2D(videoTex, vec2(cuv.x, 1.0 - cuv.y)).rgb;
    float luma = dot(cam, vec3(0.2126, 0.7152, 0.0722));
    cam = mix(cam, vec3(luma, luma, luma), uDesat);
    ground = mix(cam, vec3(1.0, 1.0, 1.0), uWhiten);
  }

  vec3 ink = vec3(uLineDark, uLineDark, uLineDark);
  gl_FragColor = vec4(mix(ground, ink, edge), 1.0);
}
`;
