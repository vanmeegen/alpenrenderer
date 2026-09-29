/**
 * The leader line between a label and its summit. The anchor is the summit
 * as drawn (labels.ts); the line stops a few pixels short of it, so that it
 * points at the mountain instead of sticking in it.
 */
import { describe, expect, test } from 'bun:test';
import type { PlacedLabel } from '../../src/engine/core/labels';
import { LEADER_GAP, leaderLine } from '../../src/app/labelPainter';

const placed = (ax: number, ay: number, bx: number, by: number, bw = 80, bh = 20) =>
  ({ ax, ay, bx, by, bw, bh }) as PlacedLabel;

describe('leader line', () => {
  test('stops a little above the anchor, straight above it', () => {
    const l = leaderLine(placed(200, 300, 160, 266));
    expect(LEADER_GAP).toBeGreaterThanOrEqual(4);
    expect(LEADER_GAP).toBeLessThanOrEqual(8);
    expect(l.tip).toEqual({ x: 200, y: 300 - LEADER_GAP });
  });

  test('reaches the bottom of the box, under the anchor as far as the box allows', () => {
    expect(leaderLine(placed(200, 300, 160, 266)).foot).toEqual({ x: 200, y: 286 });
    // A box pushed to the left edge: the foot stays on the box.
    expect(leaderLine(placed(4, 300, 2, 266, 80)).foot).toEqual({ x: 8, y: 286 });
  });
});
