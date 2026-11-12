/**
 * Finding a summit: by name among everything within range, hidden or not,
 * or in the list of what is in sight; and which way to turn for it.
 */
import { describe, expect, test } from 'bun:test';
import { foldName, pointerSpot, pointerTo, searchTargets } from '../../src/engine/core/find';
import { LabelTarget } from '../../src/engine/core/labels';

function target(name: string, o: Partial<LabelTarget> & { kind?: 'lake' } = {}): LabelTarget {
  return {
    peak: { id: `osm:node/${name}`, name, lon: 10, lat: 47, ...(o.kind === 'lake' ? { lake: 400 } : {}) },
    east: 0, north: 0, up: 0, range: 10_000, bearing: 90, elevation: 5, anchorAlt: 2000, anchor: { lon: 10, lat: 47 },
    rank: 0.01, visible: true, decided: true, spot: 0,
    ...o,
  } as LabelTarget;
}
const names = (r: { target: LabelTarget }[]) => r.map((e) => e.target.peak.name);

describe('foldName', () => {
  test('case, accents, umlauts and ß do not matter when a name is typed', () => {
    expect(foldName('Großer Bettelwurf')).toBe('grosser bettelwurf');
    expect(foldName('Säuling')).toBe('sauling');
    expect(foldName('Piz Güglia / Piz Julier')).toBe('piz guglia / piz julier');
    expect(foldName('  Aiguille du Géant ')).toBe('aiguille du geant');
    expect(foldName('Mont Blanc de Courmayeur')).toBe('mont blanc de courmayeur');
  });
});

describe('searchTargets', () => {
  const all = [
    target('Hochiss', { range: 3000, rank: 0.03 }),
    target('Rofanspitze', { range: 5000, rank: 0.05 }),
    target('Rotspitze', { range: 900, rank: 0.02 }),
    target('Großer Rettenstein', { range: 40_000, rank: 0.004, visible: false }),
    target('Seekarspitze', { range: 7000, rank: 0.01, visible: false }),
    target('Achensee', { range: 4000, rank: 0.2, kind: 'lake' }),
    target('Rofanspitze', { range: 5000, rank: 0.05, spot: 1 }),            // a spare spot of the same summit
    target('Guffert', { range: 12_000, rank: 0.03, decided: false, visible: false }),
  ];

  test('without a query it lists what is in sight, the most striking first, each summit once', () => {
    expect(names(searchTargets(all, ''))).toEqual(['Achensee', 'Rofanspitze', 'Hochiss', 'Rotspitze']);
    expect(names(searchTargets(all, '   '))).toHaveLength(4);
  });

  test('a query finds names that hold it, hidden summits too: names that begin with it first, then the visible, then the near', () => {
    const r = searchTargets(all, 'ro');
    // Rofanspitze and Rotspitze begin with it (the nearer first); the Großer Rettenstein only holds it ("grosser"), and is hidden.
    expect(names(r)).toEqual(['Rotspitze', 'Rofanspitze', 'Großer Rettenstein']);
    expect(names(searchTargets(all, 'spitze'))).toEqual(['Rotspitze', 'Rofanspitze', 'Seekarspitze']);
    expect(searchTargets(all, 'spitze').map((e) => e.visible)).toEqual([true, true, false]);
    expect(names(searchTargets(all, 'RETTEN'))).toEqual(['Großer Rettenstein']);
    expect(names(searchTargets(all, 'grosser'))).toEqual(['Großer Rettenstein']);
  });

  test('a summit whose sightline is not decided yet is found and marked so', () => {
    const [g] = searchTargets(all, 'guff');
    expect(g.target.peak.name).toBe('Guffert');
    expect(g.visible).toBe(false);
    expect(g.decided).toBe(false);
  });

  test('the list is cut at the limit', () => {
    const many = Array.from({ length: 80 }, (_, i) => target(`Kogel ${i}`, { range: 1000 + i }));
    expect(searchTargets(many, 'kogel')).toHaveLength(30);
    expect(searchTargets(many, '', 10)).toHaveLength(10);
  });
});

describe('pointerTo: which way to turn for a summit', () => {
  const cam = { yaw: 90, pitch: 0, fov: 60, aspect: 1000 / 600 };   // 60° up and down, 88° across

  test('in the frame there is nothing to point at', () => {
    expect(pointerTo(cam, target('x', { bearing: 100, elevation: 5 }))).toBeNull();
    expect(pointerTo(cam, target('x', { bearing: 60, elevation: -20 }))).toBeNull();
  });

  test('off to the right it points right and says by how much to turn; to the left likewise, the short way round', () => {
    const right = pointerTo(cam, target('x', { bearing: 170, elevation: 0 }))!;
    expect(right.turn).toBeCloseTo(80, 6);
    expect(right.dx).toBeCloseTo(1, 6);
    expect(right.dy).toBeCloseTo(0, 6);
    const left = pointerTo({ ...cam, yaw: 10 }, target('x', { bearing: 300, elevation: 0 }))!;
    expect(left.turn).toBeCloseTo(-70, 6);
    expect(left.dx).toBeCloseTo(-1, 6);
  });

  test('above the frame it points up, and diagonally when it is both', () => {
    const up = pointerTo({ ...cam, pitch: -40 }, target('x', { bearing: 90, elevation: 20 }))!;
    expect(up.turn).toBeCloseTo(0, 6);
    expect(up.dy).toBeCloseTo(-1, 6);                    // screen y runs down
    const both = pointerTo(cam, target('x', { bearing: 150, elevation: 45 }))!;
    expect(both.dx).toBeGreaterThan(0.5);
    expect(both.dy).toBeLessThan(-0.5);
    expect(Math.hypot(both.dx, both.dy)).toBeCloseTo(1, 6);
  });

  test('straight behind is a turn of 180°, and it says which way is shorter when there is one', () => {
    expect(Math.abs(pointerTo(cam, target('x', { bearing: 270, elevation: 0 }))!.turn)).toBeCloseTo(180, 6);
    expect(pointerTo(cam, target('x', { bearing: 260, elevation: 0 }))!.turn).toBeCloseTo(170, 6);
  });
});

describe('pointerSpot: where the arrow is drawn', () => {
  test('on a circle round the middle of the picture, clear of the panels at its edges', () => {
    const right = pointerSpot({ turn: 80, lift: 0, dx: 1, dy: 0 }, 1000, 600);
    expect(right.y).toBe(300);
    expect(right.x).toBeGreaterThan(700);
    expect(right.x).toBeLessThan(800);
    const up = pointerSpot({ turn: 0, lift: 60, dx: 0, dy: -1 }, 1000, 600);
    expect(up.x).toBe(500);
    expect(up.y).toBeGreaterThan(40);
    expect(up.y).toBeLessThan(100);
    // On a phone held upright the circle follows the short side.
    expect(pointerSpot({ turn: -80, lift: 0, dx: -1, dy: 0 }, 400, 800).x).toBeGreaterThan(40);
  });
});
