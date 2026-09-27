/**
 * Line icons for the menu rail, 24-unit grid, drawn with the current text
 * colour. Hand-drawn paths so that no icon font or package is needed.
 */

const PATHS = {
  fold: 'M15 5l-7 7 7 7',
  menu: 'M4 7h16M4 12h16M4 17h16',
  map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15',
  pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z M12 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  compass: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M15.5 8.5l-2 5-5 2 2-5z',
  camera: 'M3 8h4l2-3h6l2 3h4v11H3z M12 9.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7',
  photo: 'M3 4h18v16H3z M8.5 8a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3 M21 15l-5-5-11 10',
  save: 'M12 3v12 M7 10l5 5 5-5 M4 20h16',
  reset: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5',
  peaks: 'M2 20l7-12 4 6 3-4 6 10z',
  outline: 'M2 17l5-7 4 4 5-8 6 10',
  settings: 'M4 6h9 M17 6h3 M15 4v4 M4 12h3 M11 12h9 M9 10v4 M4 18h11 M19 18h1 M17 16v4',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 11v6 M12 7.5v.5',
  check: 'M3 12h4l2-6 4 12 2-6h6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
