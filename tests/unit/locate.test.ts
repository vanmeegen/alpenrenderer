import { describe, expect, test } from 'bun:test';
import { LocateError, locateChecked, locateDevice, locationHelp } from '../../src/app/mapPicker';

type Success = (p: GeolocationPosition) => void;
type Failure = (e: GeolocationPositionError) => void;

/** A Geolocation that answers the way the test says. */
function geo(behaviour: (ok: Success, fail: Failure) => void): Geolocation {
  return { getCurrentPosition: (ok, fail) => behaviour(ok, fail!) } as unknown as Geolocation;
}

const positionError = (code: number): GeolocationPositionError => ({
  code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3,
});

describe('locateDevice', () => {
  test('resolves with the fix, marked as GPS, with its accuracy', async () => {
    const g = geo((ok) => ok({ coords: { latitude: 47.5, longitude: 11.1, accuracy: 6 } } as GeolocationPosition));
    expect(await locateDevice(g)).toEqual({ lon: 11.1, lat: 47.5, source: 'gps', accuracy: 6 });
  });

  test('a refusal is a readable error', async () => {
    const g = geo((_ok, fail) => fail(positionError(1)));
    await expect(locateDevice(g)).rejects.toThrow('Standort nicht verfügbar: Zugriff verweigert.');
  });

  test('no geolocation at all is a readable error', async () => {
    await expect(locateDevice(undefined)).rejects.toThrow('Standort nicht verfügbar');
  });

  test('a browser that never answers (permission prompt left open) is not waited on forever', async () => {
    const g = geo(() => { /* never calls back */ });
    const t0 = Date.now();
    await expect(locateDevice(g, 50)).rejects.toThrow('Standort nicht verfügbar: keine Antwort.');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('a late answer after the watchdog is ignored, not a second resolution', async () => {
    let late: Success | null = null;
    const g = geo((ok) => { late = ok; });
    await expect(locateDevice(g, 20)).rejects.toThrow();
    // Calling back now must not throw or do anything.
    late!({ coords: { latitude: 1, longitude: 2, accuracy: 3 } } as GeolocationPosition);
  });
});

describe('locationHelp: what to do when the position is refused', () => {
  test('a site blocked in Chrome points at the lock icon and the site permission', () => {
    const h = locationHelp({ code: 1, permission: 'denied', secure: true });
    expect(h.title).toBe('Standort für diese Seite blockiert');
    expect(h.steps.join(' ')).toContain('Schloss');
    expect(h.steps.join(' ')).toContain('Berechtigungen');
    expect(h.retry).toBe(true);
  });

  test('a refusal while the site is allowed means the phone or Chrome itself has no location', () => {
    const h = locationHelp({ code: 1, permission: 'granted', secure: true });
    expect(h.title).toBe('Standort am Gerät aus');
    expect(h.steps.join(' ')).toContain('Einstellungen');
    expect(h.steps.join(' ')).toContain('Chrome');
  });

  test('a refusal with unknown permission state names both places to look', () => {
    const h = locationHelp({ code: 1, permission: 'unknown', secure: true });
    expect(h.steps.join(' ')).toContain('Schloss');
    expect(h.steps.join(' ')).toContain('Einstellungen');
  });

  test('no fix at all asks to switch location on and to go outside', () => {
    const h = locationHelp({ code: 2, permission: 'granted', secure: true });
    expect(h.title).toBe('Keine Position gefunden');
    expect(h.steps.join(' ')).toContain('Standort');
  });

  test('an insecure page cannot ask at all, whatever the code', () => {
    const h = locationHelp({ code: 1, permission: 'unknown', secure: false });
    expect(h.title).toBe('Nur über https');
    expect(h.retry).toBe(false);
  });

  test('the error from locateDevice carries its code for the help', async () => {
    const g = geo((_ok, fail) => fail(positionError(2)));
    const e = await locateDevice(g).catch((x) => x);
    expect(e).toBeInstanceOf(LocateError);
    expect((e as LocateError).code).toBe(2);
  });
});

describe('locateDevice retries without high accuracy', () => {
  test('when the precise fix is unavailable, a coarse one is asked for', async () => {
    const asked: boolean[] = [];
    const g = {
      getCurrentPosition: (ok: Success, fail: Failure, opt?: PositionOptions) => {
        asked.push(!!opt?.enableHighAccuracy);
        if (opt?.enableHighAccuracy) fail(positionError(2));
        else ok({ coords: { latitude: 47, longitude: 11, accuracy: 900 } } as GeolocationPosition);
      },
    } as unknown as Geolocation;
    expect(await locateDevice(g)).toEqual({ lon: 11, lat: 47, source: 'gps', accuracy: 900 });
    expect(asked).toEqual([true, false]);
  });

  test('a refusal is not retried', async () => {
    let calls = 0;
    const g = geo((_ok, fail) => { calls++; fail(positionError(1)); });
    await expect(locateDevice(g)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('locateChecked: the checks before and after asking for the position', () => {
  const fix = geo((ok) => ok({ coords: { latitude: 47.64, longitude: 11.38, accuracy: 5 } } as GeolocationPosition));
  const counting = () => {
    let calls = 0;
    const g = geo((ok) => { calls++; ok({ coords: { latitude: 1, longitude: 2, accuracy: 3 } } as GeolocationPosition); });
    return { g, calls: () => calls };
  };

  test('an insecure page gets the https help and the GPS is not asked', async () => {
    const c = counting();
    const r = await locateChecked({ geo: c.g, secure: false, permission: async () => 'prompt' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.help.title).toBe('Nur über https');
    expect(c.calls()).toBe(0);
  });

  test('a site already blocked gets the unblocking steps at once, without a doomed request', async () => {
    const c = counting();
    const r = await locateChecked({ geo: c.g, secure: true, permission: async () => 'denied' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.help.title).toBe('Standort für diese Seite blockiert');
      expect(r.message).toContain('blockiert');
    }
    expect(c.calls()).toBe(0);
  });

  test('allowed or not yet asked: the position is taken', async () => {
    for (const state of ['granted', 'prompt', 'unknown'] as const) {
      const r = await locateChecked({ geo: fix, secure: true, permission: async () => state });
      expect(r).toEqual({ ok: true, position: { lon: 11.38, lat: 47.64, source: 'gps', accuracy: 5 } });
    }
  });

  test('a refusal is explained with the permission as it stands after the prompt', async () => {
    let asked = false;
    const g = geo((_ok, fail) => { asked = true; fail(positionError(1)); });
    const r = await locateChecked({ geo: g, secure: true, permission: async () => (asked ? 'denied' : 'prompt') });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe('Standort nicht verfügbar: Zugriff verweigert.');
      expect(r.help.title).toBe('Standort für diese Seite blockiert');
    }
  });
});
