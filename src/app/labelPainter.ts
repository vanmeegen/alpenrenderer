/**
 * Draws the placed labels onto a 2D overlay canvas. From peakviewer (MIT).
 *
 * Text is stroked with a light halo before it is filled, so a name stays
 * readable on hazed blue ridges, on snow and, later, on a camera frame.
 */

import type { PlacedLabel } from '../engine/core/labels';

export interface LabelStyle {
  nameSize: number;
  detailSize: number;
  ink: string;
  halo: string;
  leader: string;
  accent: string;
  accentInk: string;
  /** Lake names: blue and italic, the way a map writes water. */
  water: string;
}

export const LABEL_STYLE: LabelStyle = {
  nameSize: 13,
  detailSize: 11,
  ink: '#0a0d11',
  halo: 'rgba(255,255,255,.93)',
  leader: 'rgba(10,13,17,.62)',
  accent: '#c2410c',
  accentInk: '#ffffff',
  water: '#1d4ed8',
};

/**
 * Pixels the leader line stops short of its anchor. The anchor is the summit
 * as the mesh draws it, exactly on the surface; a line ending there sticks in
 * the mountain. A few pixels above, it points at the summit and leaves the top
 * visible. A screen distance, so it is the same at every zoom and range.
 */
export const LEADER_GAP = 6;

/** The leader line of a label: from its tip just above the anchor to the foot on the box. */
export function leaderLine(l: Pick<PlacedLabel, 'ax' | 'ay' | 'bx' | 'by' | 'bw' | 'bh'>) {
  return {
    tip: { x: l.ax, y: l.ay - LEADER_GAP },
    foot: { x: Math.max(l.bx + 6, Math.min(l.bx + l.bw - 6, l.ax)), y: l.by + l.bh },
  };
}

export class LabelPainter {
  private ctx: CanvasRenderingContext2D;
  style: LabelStyle = LABEL_STYLE;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  private font(big: boolean, italic = false): string {
    const s = big ? this.style.nameSize : this.style.detailSize;
    return `${italic ? 'italic ' : ''}${big ? 600 : 400} ${s}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  }

  measure = (text: string, big: boolean): number => {
    this.ctx.font = this.font(big);
    return this.ctx.measureText(text).width;
  };

  /** Matches the backing store to the CSS size and clears it. */
  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, cssW, cssH);
  }

  /**
   * The summit being sought, where it stands in the picture: a ring round
   * the spot and its name over it. For one that has no label of its own,
   * because it is hidden or lost its place.
   */
  drawMark(x: number, y: number, text: string): void {
    const c = this.ctx, s = this.style;
    c.strokeStyle = s.halo;
    c.lineWidth = 5;
    c.beginPath();
    c.arc(x, y, 9, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = s.accent;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 9, 0, Math.PI * 2);
    c.stroke();
    c.font = this.font(true);
    haloText(c, s, text, x, y - 14 - s.nameSize);
  }

  /**
   * The summit being sought is out of the picture: an arrow at (x, y)
   * pointing along (dx, dy) toward it, with a line of text beside it.
   */
  drawPointer(x: number, y: number, dx: number, dy: number, text: string): void {
    const c = this.ctx, s = this.style;
    const px = -dy, py = dx;                              // across the arrow
    const tip = { x: x + dx * 16, y: y + dy * 16 };
    const shape = () => {
      c.beginPath();
      c.moveTo(tip.x, tip.y);
      c.lineTo(x - dx * 8 + px * 11, y - dy * 8 + py * 11);
      c.lineTo(x - dx * 2, y - dy * 2);
      c.lineTo(x - dx * 8 - px * 11, y - dy * 8 - py * 11);
      c.closePath();
    };
    c.lineJoin = 'round';
    c.strokeStyle = s.halo;
    c.lineWidth = 4;
    shape();
    c.stroke();
    c.fillStyle = s.accent;
    shape();
    c.fill();
    c.font = this.font(true);
    // The text on the side away from the tip, so the arrow points out of it.
    haloText(c, s, text, x - dx * 20 - (Math.abs(dx) > 0.5 ? Math.sign(dx) * this.ctx.measureText(text).width / 2 : 0), y - dy * 30 - s.nameSize / 2);
  }

  draw(labels: PlacedLabel[], selected: PlacedLabel | null): void {
    const c = this.ctx;
    const s = this.style;
    c.lineJoin = 'round';
    c.textBaseline = 'top';

    for (const l of labels) {
      const on = l === selected;
      const lake = l.target.peak.kind === 'lake';
      const { tip, foot } = leaderLine(l);

      c.strokeStyle = on ? s.accent : s.leader;
      c.lineWidth = on ? 1.6 : 1;
      c.beginPath();
      c.moveTo(tip.x, tip.y);
      c.lineTo(foot.x, foot.y);
      c.stroke();

      c.fillStyle = on ? s.accent : s.leader;
      c.beginPath();
      c.arc(tip.x, tip.y, on ? 3.4 : 2.1, 0, Math.PI * 2);
      c.fill();

      if (on) {
        c.fillStyle = s.accent;
        roundRect(c, l.bx - 4, l.by - 2, l.bw + 8, l.bh + 4, 6);
        c.fill();
      }

      let y = l.by + 3;
      l.lines.forEach((line, i) => {
        c.font = this.font(i === 0, lake && i === 0);
        c.textAlign = 'center';
        const mid = l.bx + l.bw / 2;
        if (!on) {
          c.strokeStyle = s.halo;
          c.lineWidth = 3;
          c.strokeText(line, mid, y);
        }
        c.fillStyle = on ? s.accentInk : (i === 0 ? (lake ? s.water : s.ink) : s.leader);
        c.fillText(line, mid, y);
        y += (i === 0 ? s.nameSize : s.detailSize) + 3;
      });
    }
  }
}

/** A line of text with the labels' halo, centred on x, its top at y. */
function haloText(c: CanvasRenderingContext2D, s: LabelStyle, text: string, x: number, y: number) {
  c.textAlign = 'center';
  c.textBaseline = 'top';
  c.lineJoin = 'round';
  c.strokeStyle = s.halo;
  c.lineWidth = 3;
  c.strokeText(text, x, y);
  c.fillStyle = s.accent;
  c.fillText(text, x, y);
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
