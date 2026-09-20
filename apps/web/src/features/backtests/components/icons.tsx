/**
 * The few icons the backtest list needs, inline rather than from a package.
 *
 * Four 16px glyphs do not justify a dependency, and inline SVG inherits
 * `currentColor` so they follow whatever a button is already doing on hover
 * and in dark mode without a second set of rules.
 */
const base = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

/** Points right when closed, down when open — the accordion's own state. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg {...base} style={{ transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform .15s' }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function ArchiveIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

/** Out of the box again: the same box, with the arrow coming up. */
export function RestoreIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <polyline points="9 14 12 11 15 14" />
      <path d="M12 11v6" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...base}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
