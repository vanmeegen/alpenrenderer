import { describe, expect, test } from 'bun:test';
import { DEFAULT_VIEW, EYE_HEIGHT, OUTLINE, PLACES, eyeHeightFromSlider, formatHash, hasStandpoint, readEyeHeight, readHash, readLastView, readOptions, readOutline, sliderFromEyeHeight, startView, writeEyeHeight, writeLastView, writeOutline,
  coarseFixNote, readStandSource, trailing, writeStandSource } from '../../src/app/state';

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
      backend: 'webgl2', quality: 'auto', tiles: undefined, peaks: 'peaks/{x}_{y}.json', lakes: 'lakes/{x}_{y}.json', shade: true,
    });
  });

  test('shade=0 switches the lit shade pass off; absent, 1 or garbage leave it on', () => {
    // Without the shade pass the range pass and the composite still run: the
    // outline over white that the AR view shows without a camera. The E2E
    // tests render that way unless they look at colours (SwiftShader spends
    // 10 s compiling the shade pipeline and 1 s per frame drawing it).
    expect(readOptions('?shade=0').shade).toBe(false);
    expect(readOptions('').shade).toBe(true);
    expect(readOptions('?shade=1').shade).toBe(true);
    expect(readOptions('?shade=off').shade).toBe(true);
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

describe('contour lines: how strongly the ridges are drawn', () => {
  const store = (v: string | null) => ({ getItem: () => v, setItem: () => {} }) as unknown as Storage;

  test('0.7 by default, 0 to 1, remembered to a hundredth', () => {
    expect(OUTLINE).toEqual({ min: 0, max: 1, initial: 0.7 });
    expect(readOutline(store(null))).toBe(0.7);
    expect(readOutline(store('0.456'))).toBe(0.46);
    expect(readOutline(store('7'))).toBe(1);
    expect(readOutline(store('-1'))).toBe(0);
    expect(readOutline(store('x'))).toBe(0.7);
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } as unknown as Storage;
    writeOutline(0.25, s);
    expect(readOutline(s)).toBe(0.25);
  });
});

describe('where the app starts', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } as unknown as Storage;
  };

  test('a hash with a standpoint, or a place, counts as one; an empty or view-only hash does not', () => {
    expect(hasStandpoint('#lon=10&lat=47')).toBe(true);
    expect(hasStandpoint('#p=sonnenspitz')).toBe(true);
    expect(hasStandpoint('')).toBe(false);
    expect(hasStandpoint('#yaw=90&fov=30')).toBe(false);
    expect(hasStandpoint('#lon=10')).toBe(false);
  });

  test('the last view is remembered and read back; nothing stored gives null', () => {
    const s = mem();
    expect(readLastView(s)).toBeNull();
    const v = { lon: 11.7, lat: 47.44, yaw: 200, pitch: 5, fov: 45 };
    writeLastView(v, s);
    expect(readLastView(s)).toEqual(v);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(readLastView(broken)).toBeNull();
    expect(() => writeLastView(v, broken)).not.toThrow();
  });

  test('the hash wins, then the last view, then the default; without a standpoint the device is to be asked', () => {
    const s = mem();
    const last = { lon: 11.7, lat: 47.44, yaw: 200, pitch: 5, fov: 45 };
    writeLastView(last, s);
    expect(startView('#lon=10&lat=47&yaw=90', s)).toMatchObject({ view: { lon: 10, lat: 47, yaw: 90 }, locate: false });
    expect(startView('', s)).toEqual({ view: last, locate: true });
    expect(startView('', mem())).toEqual({ view: DEFAULT_VIEW, locate: true });
    // A view-only hash keeps its angles on the remembered standpoint, and still asks.
    expect(startView('#yaw=10&fov=30', s)).toEqual({ view: { ...last, yaw: 10, fov: 30 }, locate: true });
  });

  test('a reload after a start from the device asks the device again; a map pick, a place or a shared link stand', () => {
    // The app writes the standpoint into the URL itself, so a reload always
    // found one there and "start where I am" only ever worked once.
    const s = mem(), session = mem();
    const here = { lon: 11.76411, lat: 47.44379 };
    expect(readStandSource(session)).toBeNull();
    writeStandSource('gps', here, session);
    expect(readStandSource(session)).toEqual({ source: 'gps', lon: here.lon, lat: here.lat });
    const own = '#lon=11.76411&lat=47.44379&yaw=250.0&pitch=0.0&fov=60';
    expect(startView(own, s, 1, session)).toMatchObject({ view: { lon: 11.76411, lat: 47.44379, yaw: 250 }, locate: true });
    // Another standpoint in the same tab, a link somebody shared: it stands.
    expect(startView('#lon=7.78472&lat=45.98333&yaw=232', s, 1, session).locate).toBe(false);
    // The standpoint was chosen on the map, or is a named place: it stands.
    writeStandSource('map', here, session);
    expect(startView(own, s, 1, session).locate).toBe(false);
    // A new tab knows nothing of it; storage that throws is no storage.
    expect(startView(own, s, 1, mem()).locate).toBe(false);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(startView(own, s, 1, broken).locate).toBe(false);
    expect(() => writeStandSource('gps', here, broken)).not.toThrow();
  });

  test('without a field of view anywhere, the screen\'s long side gets 60°: a sideways phone 60° across, an upright one 60° high', () => {
    expect(startView('', mem(), 0.5).view.fov).toBe(60);
    expect(startView('', mem(), 2).view.fov).toBeCloseTo(2 * Math.atan(Math.tan(Math.PI / 6) / 2) * 180 / Math.PI, 9);
    expect(startView('#lon=10&lat=47', mem(), 2).view.fov).toBeCloseTo(32.2, 1);
    expect(startView('#lon=10&lat=47&fov=60', mem(), 2).view.fov).toBe(60);
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

  test('the Mauritzalm above the Rofan top station looks over the Achensee to the Karwendel', () => {
    const p = PLACES.find((x) => x.id === 'mauritzalm')!;
    expect(p.name).toBe('Mauritzalm am Rofan (AT)');
    const local = (to: { lon: number; lat: number }) => {
      const east = (to.lon - p.lon) * 111320 * Math.cos((p.lat * Math.PI) / 180);
      const north = (to.lat - p.lat) * 111320;
      return { range: Math.hypot(east, north), bearing: ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360 };
    };
    // A short walk above the top station at the Erfurter Hütte (OSM: 47.44164° N, 11.76297° E).
    expect(local({ lon: 11.76297, lat: 47.44164 }).range).toBeLessThan(400);
    // Sonnjoch and Lamsenspitze (catalogue) both inside a 60° view, the lake's south end between them and the Stanser Joch.
    for (const summit of [{ lon: 11.60514, lat: 47.41238 }, { lon: 11.59119, lat: 47.38268 }]) {
      expect(Math.abs(local(summit).bearing - p.yaw)).toBeLessThan(30);
    }
  });
});

describe('a fix too coarse to stand on', () => {
  test('beyond 100 m the standpoint is a guess and the user is told, with the figure; a good fix says nothing', () => {
    expect(coarseFixNote(12)).toBeNull();
    expect(coarseFixNote(100)).toBeNull();
    expect(coarseFixNote(null)).toBeNull();
    expect(coarseFixNote(undefined)).toBeNull();
    expect(coarseFixNote(850)).toMatch(/± 850 m/);
    expect(coarseFixNote(2400)).toMatch(/± 2,4 km/);
    expect(coarseFixNote(850)).toMatch(/Karte/);
  });
});

describe('trailing: the latest value, at most every so often, and always in the end', () => {
  /** Timers by hand: `run(ms)` lets that much time pass. */
  function clock() {
    let now = 0, next = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    return {
      set: (fn: () => void, ms: number) => { timers.set(next, { at: now + ms, fn }); return next++; },
      clear: (id: number) => { timers.delete(id); },
      run(ms: number) {
        const end = now + ms;
        for (;;) {
          const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          timers.delete(due[0]);
          now = due[1].at;
          due[1].fn();
        }
        now = end;
      },
    };
  }

  test('a stream of values is written every interval, not held back until it stops (sensor mode: the view changes every frame)', () => {
    const c = clock(), seen: number[] = [];
    const write = trailing((v: number) => seen.push(v), 400, c);
    for (let i = 1; i <= 100; i++) { write(i); c.run(16); }       // 1.6 s of frames
    expect(seen.length).toBe(4);                                   // at 400, 800, 1200, 1600 ms
    expect(seen[0]).toBe(25);                                      // the latest at the time, not the first
    expect(seen.at(-1)).toBe(100);
  });

  test('a single value is written once, an interval later; the last one is never lost', () => {
    const c = clock(), seen: string[] = [];
    const write = trailing((v: string) => seen.push(v), 400, c);
    write('a');
    c.run(399);
    expect(seen).toEqual([]);
    c.run(1);
    expect(seen).toEqual(['a']);
    c.run(5000);
    expect(seen).toEqual(['a']);
    write('b'); write('c');
    c.run(400);
    expect(seen).toEqual(['a', 'c']);
  });

  test('cancel drops what is pending', () => {
    const c = clock(), seen: number[] = [];
    const write = trailing((v: number) => seen.push(v), 400, c);
    write(1);
    write.cancel();
    c.run(1000);
    expect(seen).toEqual([]);
  });
});
