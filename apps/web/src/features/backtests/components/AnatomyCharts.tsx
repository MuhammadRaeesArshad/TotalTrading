import type { Group } from '../stats';
import { R_BINS } from '../stats';
import { fmtR, MONTHS } from '../fmt';

/**
 * The distribution charts. Win rate is not money, so its bars are grey; net R
 * is money, so it gets green (filled) and red (hollow). Every clickable bar is
 * a real button to the keyboard.
 */

const W = 440;

function onActivate(fn: () => void) {
  return {
    onClick: fn,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    },
  };
}

export function RHistogram({ counts }: { counts: number[] }) {
  const H = 160, PL = 26, PB = 22, PT = 14;
  const max = Math.max(...counts, 1);
  const bw = (W - PL - 8) / counts.length;
  // True minus signs: a hyphen after "<" becomes an arrow ligature in the mono face.
  const n = (v: number) => (v < 0 ? `−${Math.abs(v)}` : v > 0 ? `+${v}` : '0');
  const label = ([lo, hi]: [number, number]) =>
    lo === -Infinity ? `< ${n(hi)}` : hi === Infinity ? `${n(lo)}+` : n(lo);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Trades by result in R: ${R_BINS.map((b, i) => `${label(b)}: ${counts[i]}`).join(', ')}`}>
      <line x1={PL} x2={W - 8} y1={H - PB} y2={H - PB} stroke="var(--line-strong)" />
      {counts.map((c, i) => {
        const [lo] = R_BINS[i];
        const h = (c / max) * (H - PB - PT - 12);
        const bx = PL + i * bw + 3, by = H - PB - h, w = bw - 6;
        return (
          <g key={i}>
            {lo >= 0
              ? <rect x={bx} y={by} width={w} height={h} rx={2} fill="var(--gain)" />
              : <rect x={bx + 0.75} y={by + 0.75} width={Math.max(w - 1.5, 1)} height={Math.max(h - 1.5, 0)} rx={2}
                  fill="var(--loss-dim)" stroke="var(--loss)" strokeWidth={1.5} />}
            {c > 0 && <text x={bx + w / 2} y={by - 4} textAnchor="middle">{c}</text>}
            <text x={bx + w / 2} y={H - 7} textAnchor="middle">{label(R_BINS[i])}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Win rate per session, grey bars, with the 33% breakeven for a 2R target marked. */
export function SessionBars({
  groups, order, active, onPick,
}: {
  groups: Map<string, Group>;
  order: readonly string[];
  active: string | null;
  onPick: (k: string) => void;
}) {
  const H = 160, PL = 72, PR = 70, rowH = (H - 16) / order.length;
  const scale = (v: number) => (v / 0.8) * (W - PL - PR);
  const bev = PL + scale(1 / 3);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Win rate by session">
      {order.map((k, i) => {
        const g = groups.get(k);
        const on = active === k;
        const dim = active != null && !on;
        const y0 = 4 + i * rowH;
        const w = g ? scale(g.winRate) : 0;
        return (
          <g key={k} className="hit" tabIndex={0} role="button" aria-pressed={on}
            aria-label={`${k}: win rate ${g ? (g.winRate * 100).toFixed(0) : 0}% over ${g?.n ?? 0} trades`}
            {...onActivate(() => onPick(k))}>
            <rect className="bg" x={0} y={y0} width={W} height={rowH - 2} rx={3} fill="transparent" />
            <text x={PL - 8} y={y0 + rowH / 2 + 3} textAnchor="end"
              style={{ fill: on ? 'var(--fg)' : 'var(--fg-2)', fontFamily: 'Instrument Sans, sans-serif', fontSize: 11.5 }}>{k}</text>
            <rect x={PL} y={y0 + rowH * 0.25} width={Math.max(w, 1)} height={rowH * 0.45} rx={2}
              fill="var(--fg)" opacity={dim ? 0.25 : on ? 1 : 0.7} />
            <text x={PL + w + 6} y={y0 + rowH / 2 + 3}>{g ? `${(g.winRate * 100).toFixed(0)}%` : '—'}</text>
            <text x={W - 4} y={y0 + rowH / 2 + 3} textAnchor="end"
              style={{ fill: !g || g.sumR === 0 ? 'var(--fg-3)' : g.sumR > 0 ? 'var(--gain)' : 'var(--loss)' }}>
              {g ? fmtR(g.sumR, 1) : ''}
            </text>
          </g>
        );
      })}
      <line x1={bev} x2={bev} y1={0} y2={H} stroke="var(--fg-3)" strokeDasharray="2 3" />
      <text x={bev + 3} y={H - 2}>2R breakeven</text>
    </svg>
  );
}

/** Net R per pair, diverging from zero. */
export function PairBars({
  groups, active, onPick,
}: {
  groups: Map<string, Group>;
  active: string | null;
  onPick: (k: string) => void;
}) {
  const rows = [...groups.values()].sort((a, b) => b.sumR - a.sumR);
  const rowH = 22;
  const H = Math.max(rows.length * rowH + 8, 60);
  const PL = 70, PR = 40;
  // Zero sits where the data puts it: far right when every pair lost, far
  // left when every pair won. A fixed centre ran all-negative bars into the
  // pair names. LS keeps room either side for the value labels.
  const LS = 56;
  const maxNeg = Math.max(0, ...rows.map((r) => -r.sumR));
  const maxPos = Math.max(0, ...rows.map((r) => r.sumR));
  const left = PL + LS, right = W - PR - LS;
  const span = maxNeg + maxPos || 1;
  const zero = left + (maxNeg / span) * (right - left);
  const scale = (right - left) / span;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Net R by pair">
      <line x1={zero} x2={zero} y1={0} y2={H} stroke="var(--line-strong)" />
      {rows.map((g, i) => {
        const y0 = 4 + i * rowH;
        const w = Math.abs(g.sumR) * scale;
        const on = active === g.key;
        const op = active != null && !on ? 0.3 : 1;
        return (
          <g key={g.key} className="hit" tabIndex={0} role="button" aria-pressed={on}
            aria-label={`${g.key}: ${fmtR(g.sumR, 1)} over ${g.n} trades`}
            {...onActivate(() => onPick(g.key))}>
            <rect className="bg" x={0} y={y0} width={W} height={rowH - 2} rx={3} fill="transparent" />
            <text x={PL - 8} y={y0 + rowH / 2 + 3} textAnchor="end" style={{ fill: on ? 'var(--fg)' : 'var(--fg-2)' }}>{g.key}</text>
            {g.sumR >= 0 ? (
              <>
                <rect x={zero} y={y0 + 5} width={Math.max(w, 1)} height={rowH - 12} rx={2} fill="var(--gain)" opacity={op} />
                <text x={zero + w + 5} y={y0 + rowH / 2 + 3} style={{ fill: 'var(--gain)' }} opacity={op}>{fmtR(g.sumR, 1)}</text>
              </>
            ) : (
              <>
                <rect x={zero - w + 0.75} y={y0 + 5.75} width={Math.max(w - 1.5, 1)} height={rowH - 13.5} rx={2}
                  fill="var(--loss-dim)" stroke="var(--loss)" strokeWidth={1.5} opacity={op} />
                <text x={zero - w - 5} y={y0 + rowH / 2 + 3} textAnchor="end" style={{ fill: 'var(--loss)' }} opacity={op}>{fmtR(g.sumR, 1)}</text>
              </>
            )}
            <text x={W - 4} y={y0 + rowH / 2 + 3} textAnchor="end">{g.n}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Net R per calendar month. Money, so green/red intensity is allowed. */
export function MonthHeatmap({
  groups, years, active, onPick,
}: {
  groups: Map<string, Group>;
  years: number[];
  active: string | null;
  onPick: (k: string) => void;
}) {
  const PL = 42, PT = 16, rh = 24;
  const H = PT + years.length * rh + 4;
  const cw = (W - PL - 4) / 12;
  const max = Math.max(...[...groups.values()].map((g) => Math.abs(g.sumR)), 1);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Net R by month">
      {MONTHS.map((m, i) => <text key={m} x={PL + i * cw + cw / 2} y={10} textAnchor="middle">{m[0]}</text>)}
      {years.map((yr, ri) => (
        <g key={yr}>
          <text x={PL - 6} y={PT + ri * rh + rh / 2 + 3} textAnchor="end">{yr}</text>
          {MONTHS.map((m, mi) => {
            const key = `${yr}-${String(mi + 1).padStart(2, '0')}`;
            const g = groups.get(key);
            const cx = PL + mi * cw + 1.5, cy = PT + ri * rh + 1.5;
            if (!g) {
              return <rect key={key} x={cx} y={cy} width={cw - 3} height={rh - 3} rx={3} fill="none" stroke="var(--line)" strokeDasharray="2 2" />;
            }
            const a = Math.round((0.14 + (0.72 * Math.abs(g.sumR)) / max) * 100);
            const on = active === key;
            const fill = g.sumR >= 0
              ? `color-mix(in srgb, var(--gain) ${a}%, transparent)`
              : `color-mix(in srgb, var(--loss) ${a}%, transparent)`;
            return (
              <g key={key} className="hit" tabIndex={0} role="button" aria-pressed={on}
                aria-label={`${m} ${yr}: ${fmtR(g.sumR, 1)} over ${g.n} trades`}
                {...onActivate(() => onPick(key))}>
                <rect x={cx} y={cy} width={cw - 3} height={rh - 3} rx={3} fill={fill}
                  stroke={on ? 'var(--fg)' : 'var(--line)'} strokeWidth={on ? 1.5 : 1} />
                <text x={cx + (cw - 3) / 2} y={cy + (rh - 3) / 2 + 3} textAnchor="middle" style={{ fill: 'var(--fg)', fontSize: 9 }}>
                  {`${g.sumR > 0 ? '+' : g.sumR < 0 ? '−' : ''}${Math.abs(g.sumR).toFixed(0)}`}
                </text>
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}
