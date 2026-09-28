import { describe, expect, test } from 'bun:test';
import { DEFAULT_VIEW, EYE_RADIUS, PLACES, formatHash, readEyeRadius, readHash, readOptions, writeEyeRadius } from '../../src/app/state';

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

describe('eye radius: the area the eye height is taken from', () => {
  const store = (v: string | null) => ({ getItem: () => v, setItem: () => {} }) as unknown as Storage;

  test('1 km by default, 10 m to 2 km', () => {
    expect(EYE_RADIUS).toEqual({ min: 10, max: 2000, initial: 1000 });
    expect(readEyeRadius(store(null))).toBe(1000);
  });

  test('a stored value is used, clamped to the slider', () => {
    expect(readEyeRadius(store('250'))).toBe(250);
    expect(readEyeRadius(store('5'))).toBe(10);
    expect(readEyeRadius(store('99999'))).toBe(2000);
    expect(readEyeRadius(store('kaputt'))).toBe(1000);
  });

  test('storage that throws (private mode) falls back to the default', () => {
    const broken = { getItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(readEyeRadius(broken)).toBe(1000);
    expect(() => writeEyeRadius(300, broken)).not.toThrow();
  });

  test('what is written is read back', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } as unknown as Storage;
    writeEyeRadius(420, s);
    expect(readEyeRadius(s)).toBe(420);
  });
});
