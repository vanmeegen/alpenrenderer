/**
 * Where one stands, from the device's fixes: on a summit when the fix says
 * so within its accuracy, and following the device without jumping at
 * every wobble of the GPS.
 */
import { describe, expect, test } from 'bun:test';
import { FOLLOW, FollowFilter, SNAP, snapRadius, summitUnder } from '../../src/engine/core/stand';
import { Peak } from '../../src/engine/core/peaks';

const LAT = 47.3, LON = 11.2;
const M_LAT = 111195, M_LON = 111195 * Math.cos((LAT * Math.PI) / 180);
/** A point `east` and `north` metres from the reference. */
const at = (east: number, north: number) => ({ lon: LON + east / M_LON, lat: LAT + north / M_LAT });
const peak = (name: string, east: number, north: number, extra: Partial<Peak> = {}): Peak => ({ id: `osm:node/${name}`, name, ...at(east, north), ...extra });

describe('summitUnder: standing on a summit', () => {
  const peaks = [peak('Hochiss', 0, 0), peak('Vorgipfel', 40, 0), peak('Nachbar', 900, 300), peak('Zireiner See', 5, 5, { kind: 'lake' } as Partial<Peak>)];

  test('a fix within its accuracy of a catalogued summit stands on it: the nearest one, never a lake', () => {
    const s = summitUnder({ ...at(12, -9), accuracy: 20 }, peaks)!;
    expect(s.peak.name).toBe('Hochiss');
    expect(s.distance).toBeCloseTo(15, 0);
    expect(summitUnder({ ...at(30, 0), accuracy: 20 }, peaks)!.peak.name).toBe('Vorgipfel');
  });

  test('farther off than the fix is good for, one stands beside the summit, not on it', () => {
    expect(summitUnder({ ...at(60, 60), accuracy: 20 }, [peaks[0]])).toBeNull();
    expect(summitUnder({ ...at(200, 0), accuracy: 60 }, [peaks[0]])).toBeNull();
  });

  test('the radius is the accuracy, 15 m at least (a perfect fix is still a person on a cairn) and 60 m at most', () => {
    expect(snapRadius(4)).toBe(SNAP.minRadius);
    expect(snapRadius(35)).toBe(35);
    expect(snapRadius(90)).toBe(SNAP.maxRadius);
    expect(snapRadius(undefined)).toBe(SNAP.minRadius);
    expect(SNAP.minRadius).toBe(15);
    expect(SNAP.maxRadius).toBe(60);
    expect(summitUnder({ ...at(12, 0), accuracy: 0 }, [peaks[0]])!.peak.name).toBe('Hochiss');
    expect(summitUnder({ ...at(55, 0), accuracy: 90 }, [peaks[0]])!.peak.name).toBe('Hochiss');
  });

  test('a fix that is only a guess (worse than 100 m) puts nobody on a summit', () => {
    expect(summitUnder({ ...at(10, 0), accuracy: 400 }, [peaks[0]])).toBeNull();
  });
});

describe('FollowFilter: following the device', () => {
  const fix = (east: number, north: number, accuracy = 8) => ({ ...at(east, north), accuracy });

  test('the first fix is taken; standing still with a wobbling GPS moves nothing', () => {
    const f = new FollowFilter();
    expect(f.accept(fix(0, 0), 0)).toBe(true);
    for (let i = 1; i <= 20; i++) expect(f.accept(fix((i % 3) * 3 - 3, (i % 2) * 4 - 2), i * 1000)).toBe(false);
  });

  test('walking, the standpoint follows every ten metres from where it last stood, not at every step', () => {
    const f = new FollowFilter();
    f.accept(fix(0, 0), 0);
    const taken: number[] = [];
    for (let i = 1; i <= 30; i++) if (f.accept(fix(i * 1.5, 0), i * 1000)) taken.push(i * 1.5);
    expect(taken).toEqual([10.5, 21, 31.5, 42]);
    expect(FOLLOW.minMove).toBe(10);
  });

  test('not more often than every two seconds, however fast the fixes come', () => {
    const f = new FollowFilter();
    f.accept(fix(0, 0), 0);
    expect(f.accept(fix(50, 0), 500)).toBe(false);
    expect(f.accept(fix(55, 0), 1900)).toBe(false);
    expect(f.accept(fix(60, 0), 2000)).toBe(true);
    expect(FOLLOW.minInterval).toBe(2000);
  });

  test('a move that comes too soon is not lost: the filter says when to offer it again, and then it is taken', () => {
    // A device that stops after its last step sends no further fix: the one held back has to be offered again.
    const f = new FollowFilter();
    f.accept(fix(0, 0), 0);
    const early = f.judge(fix(50, 0), 500);
    expect(early.take).toBe(false);
    expect(early.again).toBe(1500);
    expect(f.judge(fix(50, 0), 2000).take).toBe(true);
    // A wobble is not offered again: there is nothing to wait for.
    expect(f.judge(fix(52, 0), 2100)).toEqual({ take: false });
    expect(f.judge(fix(52, 0), 9000)).toEqual({ take: false });
  });

  test('a coarse fix is a move only beyond half its own accuracy: 30 m off at ± 80 m is the same place, 50 m off is not', () => {
    const f = new FollowFilter();
    f.accept(fix(0, 0, 8), 0);
    expect(f.accept(fix(30, 0, 80), 5000)).toBe(false);
    expect(f.accept(fix(50, 0, 80), 6000)).toBe(true);
  });

  test('reset: the next fix is the first again', () => {
    const f = new FollowFilter();
    f.accept(fix(0, 0), 0);
    f.reset();
    expect(f.accept(fix(1, 0), 100)).toBe(true);
  });
});
