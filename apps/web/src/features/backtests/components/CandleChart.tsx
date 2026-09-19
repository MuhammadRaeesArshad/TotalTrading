import { useMemo } from 'react';
import type { Bars, Trade } from '../types';
import { fmtWhen, priceDp } from '../fmt';

const W = 720;
const H = 330;
const PL = 8;
const PR = 96; // room for level labels
const PT = 14;
const PB = 24;

interface Level {
  y: number;
  price: number;
  label: string;
  color: string;
  dash?: string;
  labelY: number;
}

/**
 * Price bars around one trade, with the detector's reasoning drawn on top:
 * the order-block zone, the level whose break set the trend, the fill on the
 * bar *after* the touch (where the engine actually fills), stop, target and
 * exit. Candles are grey — price is not profit.
 */
export function CandleChart({ bars, trade }: { bars: Bars; trade: Trade }) {
  const g = useMemo(() => layout(bars, trade), [bars, trade]);

  if (!g) {
    return <div className="empty"><p>No bars cached around this trade. Re-import this pair's history.</p></div>;
  }

  const { x, y, bw, n, entryIdx, exitIdx, zoneFrom, win, levels, dp } = g;
  const d = trade.detail ?? {};
  const hasZone = Number.isFinite(d.zone_high) && Number.isFinite(d.zone_low);
  const hasBos = Number.isFinite(d.bos_price);
  const long = trade.direction === 'long';

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${trade.symbol} ${trade.direction} trade: entry ${trade.entryPrice.toFixed(dp)}, stop ${trade.stopLoss.toFixed(dp)}, exit ${trade.exitPrice.toFixed(dp)}`}>
      {hasZone && (
        <>
          <rect x={x(zoneFrom) - bw / 2} y={y(d.zone_high)} width={Math.max(x(entryIdx) - x(zoneFrom), bw)}
            height={Math.max(y(d.zone_low) - y(d.zone_high), 1)}
            fill="var(--fg)" opacity={0.08} stroke="var(--line-strong)" strokeDasharray="3 3" />
          {/* Left of the zone, not under it: under it is where the stop sits. */}
          <text className="halo" x={x(zoneFrom) - bw / 2 - 4} y={(y(d.zone_high) + y(d.zone_low)) / 2 + 3} textAnchor="end">order block</text>
        </>
      )}
      {hasBos && (
        <>
          <line x1={x(Math.max(zoneFrom - 8, 0))} x2={x(zoneFrom) + bw} y1={y(d.bos_price)} y2={y(d.bos_price)}
            stroke="var(--fg-2)" strokeDasharray="5 3" />
          <text className="halo" x={x(Math.max(zoneFrom - 8, 0))} y={y(d.bos_price) + (long ? -5 : 12)}>
            swing {long ? 'high' : 'low'} broken
          </text>
        </>
      )}

      {levels.map((l) => (
        <line key={l.label} x1={x(entryIdx) - bw / 2} x2={W - PR + 4} y1={l.y} y2={l.y}
          stroke={l.color} strokeDasharray={l.dash} strokeWidth={1.2} />
      ))}

      {g.candles.map((c, i) => {
        const up = c.c >= c.o;
        const key = i === entryIdx || i === exitIdx;
        const top = y(Math.max(c.o, c.c));
        const h = Math.max(y(Math.min(c.o, c.c)) - top, 1);
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={key ? 'var(--fg)' : 'var(--fg-3)'} />
            {up
              ? <rect x={x(i) - bw * 0.32} y={top} width={bw * 0.64} height={h} fill="var(--bg)" stroke={key ? 'var(--fg)' : 'var(--fg-2)'} />
              : <rect x={x(i) - bw * 0.32} y={top} width={bw * 0.64} height={h} fill={key ? 'var(--fg)' : 'var(--fg-3)'} />}
          </g>
        );
      })}

      {/* Fill: a triangle pointing the trade's way, on the entry bar. */}
      <path d={long
        ? `M${x(entryIdx)},${y(trade.entryPrice) + 3} l-5,9 h10 z`
        : `M${x(entryIdx)},${y(trade.entryPrice) - 3} l-5,-9 h10 z`}
        fill="var(--fg)" />
      {win
        ? <circle cx={x(exitIdx)} cy={y(trade.exitPrice)} r={5} fill="var(--gain)" />
        : <circle cx={x(exitIdx)} cy={y(trade.exitPrice)} r={4.5} fill="var(--bg)" stroke="var(--loss)" strokeWidth={2} />}

      {levels.map((l) => (
        <g key={`${l.label}-t`}>
          <text x={W - PR + 8} y={l.labelY - 1} style={{ fill: l.color }}>{l.label}</text>
          <text x={W - PR + 8} y={l.labelY + 10}>{l.price.toFixed(dp)}</text>
        </g>
      ))}

      <text x={PL} y={H - 6}>{fmtWhen(new Date(bars.time[0] * 1000).toISOString())}</text>
      <text x={x(entryIdx)} y={H - 6} textAnchor="middle">fill</text>
      {exitIdx - entryIdx > 3 && <text x={x(exitIdx)} y={H - 6} textAnchor="middle">exit</text>}
      <text x={W - PR} y={H - 6} textAnchor="end">{fmtWhen(new Date(bars.time[n - 1] * 1000).toISOString())}</text>
    </svg>
  );
}

function layout(bars: Bars, trade: Trade) {
  const n = bars.count;
  if (!n) return null;

  const entryTs = new Date(trade.entryTime).getTime() / 1000;
  const exitTs = new Date(trade.exitTime).getTime() / 1000;
  const find = (ts: number) => {
    const i = bars.time.findIndex((t) => t >= ts);
    return i === -1 ? n - 1 : i;
  };
  const entryIdx = find(entryTs);
  const exitIdx = Math.max(find(exitTs), entryIdx);
  const age = trade.detail?.zone_age_bars;
  // The zone went live on the break, `zone_age_bars` before the touch; the
  // touch is the bar before the fill.
  const zoneFrom = Math.max(0, entryIdx - 1 - (typeof age === 'number' && Number.isFinite(age) ? age : 6));

  const candles = bars.time.map((_, i) => ({ o: bars.open[i], h: bars.high[i], l: bars.low[i], c: bars.close[i] }));
  const d = trade.detail ?? {};
  const prices = [
    ...bars.high, ...bars.low, trade.stopLoss, trade.entryPrice, trade.exitPrice,
    ...(trade.takeProfit != null ? [trade.takeProfit] : []),
    ...[d.zone_high, d.zone_low, d.bos_price].filter((v) => Number.isFinite(v)),
  ];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pad = (hi - lo) * 0.06 || hi * 0.001;
  const y = (v: number) => PT + ((hi + pad - v) / (hi + pad - (lo - pad))) * (H - PT - PB);
  const bw = (W - PL - PR) / n;
  const x = (i: number) => PL + i * bw + bw / 2;

  const win = trade.netProfit >= 0;
  const raw: Omit<Level, 'labelY'>[] = [
    { y: y(trade.entryPrice), price: trade.entryPrice, label: 'fill', color: 'var(--fg)' },
    { y: y(trade.stopLoss), price: trade.stopLoss, label: 'stop', color: 'var(--loss)', dash: '4 3' },
    ...(trade.takeProfit != null
      ? [{ y: y(trade.takeProfit), price: trade.takeProfit, label: 'target', color: 'var(--gain)', dash: '4 3' }]
      : []),
  ];
  // Keep the margin labels at least 24px apart so price text never collides.
  const sorted = [...raw].sort((a, b) => a.y - b.y);
  let last = -Infinity;
  const levels = sorted.map((l) => {
    const labelY = Math.max(l.y, last + 24);
    last = labelY;
    return { ...l, labelY };
  });

  return { x, y, bw, n, entryIdx, exitIdx, zoneFrom, candles, win, levels, dp: priceDp(trade.symbol) };
}
