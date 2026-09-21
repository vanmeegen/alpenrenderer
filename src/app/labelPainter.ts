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
}

export const LABEL_STYLE: LabelStyle = {
  nameSize: 13,
  detailSize: 11,
  ink: '#0a0d11',
  halo: 'rgba(255,255,255,.93)',
  leader: 'rgba(10,13,17,.62)',
  accent: '#c2410c',
  accentInk: '#ffffff',
};

export class LabelPainter {
  private ctx: CanvasRenderingContext2D;
  style: LabelStyle = LABEL_STYLE;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  private font(big: boolean): string {
    const s = big ? this.style.nameSize : this.style.detailSize;
    return `${big ? 600 : 400} ${s}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
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

  draw(labels: PlacedLabel[], selected: PlacedLabel | null): void {
    const c = this.ctx;
    const s = this.style;
    c.lineJoin = 'round';
    c.textBaseline = 'top';

    for (const l of labels) {
      const on = l === selected;
      const cx = Math.max(l.bx + 6, Math.min(l.bx + l.bw - 6, l.ax));

      c.strokeStyle = on ? s.accent : s.leader;
      c.lineWidth = on ? 1.6 : 1;
      c.beginPath();
      c.moveTo(l.ax, l.ay);
      c.lineTo(cx, l.by + l.bh);
      c.stroke();

      c.fillStyle = on ? s.accent : s.leader;
      c.beginPath();
      c.arc(l.ax, l.ay, on ? 3.4 : 2.1, 0, Math.PI * 2);
      c.fill();

      if (on) {
        c.fillStyle = s.accent;
        roundRect(c, l.bx - 4, l.by - 2, l.bw + 8, l.bh + 4, 6);
        c.fill();
      }

      let y = l.by + 3;
      l.lines.forEach((line, i) => {
        c.font = this.font(i === 0);
        c.textAlign = 'center';
        const mid = l.bx + l.bw / 2;
        if (!on) {
          c.strokeStyle = s.halo;
          c.lineWidth = 3;
          c.strokeText(line, mid, y);
        }
        c.fillStyle = on ? s.accentInk : (i === 0 ? s.ink : s.leader);
        c.fillText(line, mid, y);
        y += (i === 0 ? s.nameSize : s.detailSize) + 3;
      });
    }
  }
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
