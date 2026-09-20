import { useRef, useState } from 'react';
import type { Trade } from '../types';

const W = 960;
const H = 270;
const PL = 52;
const PR = 14;
const PT = 12;
const PB = 24;
const DDH = 54;

export interface EquityPoint { t: number; equity: number; drawdown: number; trade: Trade }

/**
 * Equity after each trade, with drawdown drawn as area underneath. Drag across
 * it to choose a window; `onSelect` gets the time range, or null for "all".
 * Winning trades are filled dots, losing ones hollow.
 */
export function EquityChart({
  points, start, selection, onSelect,
}: {
  points: EquityPoint[];
  start: number;
  selection: [number, number] | null;
  onSelect: (range: [number, number] | null) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  if (points.length < 2) {
    return <div className="empty"><p>Not enough trades to draw an equity curve.</p></div>;
  }

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(t1 - t0, 1);
  const x = (t: number) => PL + ((t - t0) / span) * (W - PL - PR);
  const invx = (px: number) => t0 + ((Math.min(Math.max(px, PL), W - PR) - PL) / (W - PL - PR)) * span;

  const eqs = [start, ...points.map((p) => p.equity)];
  const step = niceStep((Math.max(...eqs) - Math.min(...eqs)) || start * 0.1);
  const lo = Math.floor(Math.min(...eqs) / step) * step;
  const hi = Math.ceil(Math.max(...eqs) / step) * step;
  const bottom = H - PB - DDH - 10;
  const y = (v: number) => PT + ((hi - v) / (hi - lo || 1)) * (bottom - PT);
  const ddMax = Math.max(...points.map((p) => p.drawdown), 0.01);
  const ddTop = H - PB - DDH;
  const ydd = (v: number) => ddTop + (v / ddMax) * DDH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.equity).toFixed(1)}`).join('');
  const range = drag ? [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)] : selection;
  const inRange = (t: number) => !range || (t >= range[0] && t <= range[1]);

  const toTime = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return invx(((e.clientX - r.left) / r.width) * W);
  };

  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
  const years: number[] = [];
  for (let yr = new Date(t0).getUTCFullYear() + 1; yr <= new Date(t1).getUTCFullYear(); yr++) years.push(yr);

  return (
    <svg ref={svg} className="chart brushable" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label="Equity curve with drawdown underneath. Drag to choose a window."
      onPointerDown={(e) => { svg.current!.setPointerCapture(e.pointerId); const t = toTime(e); setDrag({ from: t, to: t }); }}
      onPointerMove={(e) => drag && setDrag({ ...drag, to: toTime(e) })}
      onPointerUp={(e) => {
        if (!drag) return;
        const to = toTime(e);
        setDrag(null);
        // A click, not a drag, clears the selection.
        if (Math.abs(x(to) - x(drag.from)) < 4) onSelect(null);
        else onSelect([Math.min(drag.from, to), Math.max(drag.from, to)]);
      }}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          <text x={PL - 8} y={y(v) + 3} textAnchor="end">{compact(v)}</text>
        </g>
      ))}
      {years.map((yr) => {
        const px = x(Date.UTC(yr, 0, 1));
        return (
          <g key={yr}>
            <line x1={px} x2={px} y1={PT} y2={H - PB} stroke="var(--line)" strokeDasharray="2 3" />
            <text x={px + 4} y={H - 8}>{yr}</text>
          </g>
        );
      })}
      {range && (
        <rect x={x(range[0])} y={PT} width={Math.max(x(range[1]) - x(range[0]), 1)} height={H - PB - PT}
          fill="var(--fg)" opacity={0.06} stroke="var(--line-strong)" />
      )}
      <line x1={PL} x2={W - PR} y1={y(start)} y2={y(start)} stroke="var(--fg-3)" strokeDasharray="3 3" />
      <path d={`${line}L${x(t1)},${bottom}L${x(t0)},${bottom}Z`} fill="var(--fg)" opacity={0.05} />
      <path d={line} fill="none" stroke="var(--fg)" strokeWidth={1.5} />

      <line x1={PL} x2={W - PR} y1={ddTop} y2={ddTop} stroke="var(--line-strong)" />
      <text x={PL - 8} y={ddTop + 10} textAnchor="end">DD</text>
      <text x={PL - 8} y={ddTop + DDH} textAnchor="end">−{(ddMax * 100).toFixed(0)}%</text>
      <path d={`M${x(t0)},${ddTop}${points.map((p) => `L${x(p.t).toFixed(1)},${ydd(p.drawdown).toFixed(1)}`).join('')}L${x(t1)},${ddTop}Z`}
        fill="var(--loss)" opacity={0.28} />

      {points.length <= 3000 && points.map((p) => {
        const on = inRange(p.t);
        return p.trade.netProfit >= 0
          ? <circle key={p.trade._id} cx={x(p.t)} cy={y(p.equity)} r={2.4} fill="var(--gain)" opacity={on ? 1 : 0.2} />
          : <circle key={p.trade._id} cx={x(p.t)} cy={y(p.equity)} r={2.2} fill="var(--bg)" stroke="var(--loss)" strokeWidth={1.1} opacity={on ? 1 : 0.2} />;
      })}
    </svg>
  );
}

function niceStep(span: number) {
  const raw = span / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

function compact(v: number) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(v));
}
