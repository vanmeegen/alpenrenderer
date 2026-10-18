import { describe, expect, test } from 'bun:test';
import { DEFAULT_VIEW, EYE_HEIGHT, PLACES, eyeHeightFromSlider, formatHash, readEyeHeight, readHash, readOptions, sliderFromEyeHeight, writeEyeHeight } from '../../src/app/state';

describe('readHash', () => {
  test('empty hash is the default view', () => {
    expect(readHash('')).toEqual(DEFAULT_VIEW);
    expect(readHash('#')).toEqual(DEFAULT_VIEW);
  });

  test('reads every field and clamps pitch and fov', () => {
    const v = readHash('#lon=10.5&lat=47.25&alt=2500&yaw=370&pitch=200&fov=1');
    expect(v).toEqual({ lon: 10.5, lat: 47.25, alt: 2500, yaw: 10, pitch: 89, fov: 5 });
  });

  test('a place id sets position and bearing, explicit fields win', () => {
    const z = PLACES.find((p) => p.id === 'zugspitze')!;
    expect(readHash('#p=zugspitze')).toMatchObject({ lon: z.lon, lat: z.lat, yaw: z.yaw });
    expect(readHash('#p=zugspitze&yaw=5').yaw).toBe(5);
  });

  test('garbage falls back to defaults', () => {
    expect(readHash('#lon=abc&lat=&fov=NaN')).toEqual(DEFAULT_VIEW);
    expect(readHash('#alt=xyz').alt).toBeUndefined();
  });
});

describe('formatHash', () => {
  test('round-trips through readHash', () => {
    const v = { lon: 7.78472, lat: 45.98333, alt: 3135, yaw: 232.4, pitch: -3.5, fov: 60 };
    expect(readHash(formatHash(v))).toEqual(v);
  });

  test('omits alt when standing on the ground', () => {
    expect(formatHash({ lon: 1, lat: 2, yaw: 3, pitch: 4, fov: 50 })).not.toContain('alt=');
  });
});

describe('readOptions', () => {
  test('defaults to WebGL2 and automatic quality', () => {
    expect(readOptions('')).toEqual({
      backend: 'webgl2', quality: 'auto', tiles: undefined, peaks: 'peaks/{x}_{y}.json', lakes: 'lakes/{x}_{y}.json',
    });
  });

  test('tiles base becomes a URL template with a trailing slash', () => {
    expect(readOptions('?tiles=/tile-cache').tiles).toBe('/tile-cache/{z}/{x}/{y}.webp');
    expect(readOptions('?tiles=/tile-cache/').tiles).toBe('/tile-cache/{z}/{x}/{y}.webp');
  });

  test('peaks base becomes a cell URL template, default next to the app', () => {
    expect(readOptions('?peaks=/tests/e2e/fixtures/peaks').peaks).toBe('/tests/e2e/fixtures/peaks/{x}_{y}.json');
    expect(readOptions('?peaks=/p/').peaks).toBe('/p/{x}_{y}.json');
  });

  test('lakes base becomes a cell URL template like the peaks', () => {
    expect(readOptions('?lakes=/tests/e2e/fixtures/lakes').lakes).toBe('/tests/e2e/fixtures/lakes/{x}_{y}.json');
  });

  test('backend and quality overrides', () => {
    expect(readOptions('?backend=webgpu&q=low')).toMatchObject({ backend: 'webgpu', quality: 'low' });
    expect(readOptions('?backend=foo&q=bar')).toMatchObject({ backend: 'webgl2', quality: 'auto' });
  });
});

describe('eye height: metres above the ground under the standpoint', () => {
  const store = (v: string | null) => ({ getItem: () => v, setItem: () => {} }) as unknown as Storage;

  test('1.7 m by default, 1.7 m to 500 m', () => {
    expect(EYE_HEIGHT).toEqual({ min: 1.7, max: 500, initial: 1.7 });
    expect(readEyeHeight(store(null))).toBe(1.7);
  });

  test('a stored value is used, clamped to the slider, to a tenth of a metre', () => {
    expect(readEyeHeight(store('25'))).toBe(25);
    expect(readEyeHeight(store('29.149'))).toBe(29.1);
    expect(readEyeHeight(store('0.5'))).toBe(1.7);
    expect(readEyeHeight(store('99999'))).toBe(500);
    expect(readEyeHeight(store('kaputt'))).toBe(1.7);
  });

  test('storage that throws (private mode) falls back to the default', () => {
    const broken = { getItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(readEyeHeight(broken)).toBe(1.7);
    expect(() => writeEyeHeight(30, broken)).not.toThrow();
  });

  test('what is written is read back', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } as unknown as Storage;
    writeEyeHeight(42.5, s);
    expect(readEyeHeight(s)).toBe(42.5);
  });

  test('the slider is logarithmic: 0 is standing height, 100 is the top, 50 is the geometric middle', () => {
    expect(eyeHeightFromSlider(0)).toBeCloseTo(1.7, 6);
    expect(eyeHeightFromSlider(100)).toBeCloseTo(500, 6);
    expect(eyeHeightFromSlider(50)).toBeCloseTo(Math.sqrt(1.7 * 500), 6);
    for (const t of [0, 13, 50, 87, 100]) expect(sliderFromEyeHeight(eyeHeightFromSlider(t))).toBeCloseTo(t, 6);
  });
});

describe('places', () => {
  test('the Sonnenspitz above Kochel looks out over the Kochelsee', () => {
    const p = PLACES.find((x) => x.id === 'sonnenspitz')!;
    expect(p.name).toBe('Kochelsee vom Sonnenspitz (DE)');
    // The lake's centre, from the lake catalogue: the view points at it within a few degrees.
    const lake = { lon: 11.34587, lat: 47.64679 };
    const east = (lake.lon - p.lon) * 111320 * Math.cos((p.lat * Math.PI) / 180);
    const north = (lake.lat - p.lat) * 111320;
    const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
    expect(Math.abs(p.yaw - bearing)).toBeLessThan(5);
    expect(Math.hypot(east, north)).toBeLessThan(3000);     // the lake right below, not on the horizon
  });
});
