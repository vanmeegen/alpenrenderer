/**
 * Compass rose: the rose turns under a fixed view mark, so "where you are
 * looking" stays at the top and north moves. In sensor mode a dot orbits at
 * the angle of the manual correction, because the amount of fudge applied
 * to the compass is worth seeing rather than hiding.
 */

export interface CompassRoseProps {
  yaw: number;
  /** Signed horizontal correction, degrees; drawn only when `sensors` is on. */
  offset: number;
  sensors: boolean;
  size?: number;
}

export function CompassRose({ yaw, offset, sensors, size = 72 }: CompassRoseProps) {
  const c = size / 2, r = size / 2 - 10;
  const ticks = [];
  for (let b = 0; b < 360; b += 30) {
    const major = b % 90 === 0;
    const a = (b * Math.PI) / 180;
    const inner = r - (major ? 8 : 4);
    ticks.push(<line key={b} x1={c + Math.sin(a) * inner} y1={c - Math.cos(a) * inner}
      x2={c + Math.sin(a) * r} y2={c - Math.cos(a) * r}
      stroke={major ? 'rgba(0,0,0,.8)' : 'rgba(0,0,0,.3)'} strokeWidth={major ? 1.5 : 1} />);
  }
  const oa = (offset * Math.PI) / 180;
  const warn = Math.abs(offset) > 8;
  return (
    <svg className="alp-compass pointer-events-none" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      data-yaw={yaw.toFixed(1)} data-offset={sensors ? offset.toFixed(1) : ''} aria-label={`Kompass ${yaw.toFixed(0)}°`}>
      <circle cx={c} cy={c} r={r + 6} fill="rgba(255,255,255,.85)" stroke="rgba(0,0,0,.15)" />
      <g transform={`rotate(${-yaw} ${c} ${c})`}>
        {ticks}
        <path d={`M${c} ${c - r + 2} L${c - 4.5} ${c - r + 13} L${c + 4.5} ${c - r + 13} Z`} fill="#dc2626" />
        <text x={c} y={c - r + 22} textAnchor="middle" fontSize="9" fontWeight={700} fill="#dc2626">N</text>
      </g>
      <path d={`M${c} ${c - r - 8} L${c - 5} ${c - r - 1} L${c + 5} ${c - r - 1} Z`} fill="#1d4ed8" />
      {sensors && (
        <circle cx={c + Math.sin(oa) * (r + 6)} cy={c - Math.cos(oa) * (r + 6)} r={3.6}
          fill={warn ? '#dc2626' : '#0284c7'} stroke="rgba(0,0,0,.5)" />
      )}
      <text x={c} y={c + 3} textAnchor="middle" fontSize="10" fontFamily="ui-monospace, monospace" fill="#262626">
        {sensors && Math.abs(offset) > 0.05 ? `${offset > 0 ? '+' : ''}${offset.toFixed(0)}°` : `${yaw.toFixed(0)}°`}
      </text>
    </svg>
  );
}
