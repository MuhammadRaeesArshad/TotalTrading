import { useMemo, useState } from 'react';
import type { Run, Trade } from '../types';
import { byExit, equityPath, summarize } from '../stats';
import { fmtMoney, fmtPct, fmtR, moneyClass } from '../fmt';
import { EquityChart } from './EquityChart';
import { TradeRows } from './TradeRows';

/**
 * When did it make and lose its money? Drag across the curve or pick a preset;
 * every figure below recomputes for that window. The presets are also the
 * keyboard path to the same thing.
 */
export function ReplayTab({ run, trades, onOpen }: { run: Run; trades: Trade[]; onOpen: (id: string) => void }) {
  const points = useMemo(() => equityPath(trades, run.initialBalance), [trades, run.initialBalance]);
  const ordered = useMemo(() => [...trades].sort(byExit), [trades]);
  const all = useMemo(() => summarize(trades, run.initialBalance), [trades, run.initialBalance]);

  const years = useMemo(() => [...new Set(points.map((p) => new Date(p.t).getUTCFullYear()))], [points]);
  const worst: [number, number] | null = all.ddTrough >= 0
    ? [points[Math.max(all.ddPeak, 0)].t, points[all.ddTrough].t]
    : null;
  const presets: { name: string; range: [number, number] | null }[] = [
    { name: 'All', range: null },
    ...years.map((y) => ({ name: String(y), range: [Date.UTC(y, 0, 1), Date.UTC(y, 11, 31, 23, 59)] as [number, number] })),
    ...(worst ? [{ name: 'Worst drawdown', range: worst }] : []),
  ];

  const [sel, setSel] = useState<[number, number] | null>(null);
  const [active, setActive] = useState('All');

  const inWin = useMemo(
    () => (sel ? ordered.filter((t) => { const x = new Date(t.exitTime).getTime(); return x >= sel[0] && x <= sel[1]; }) : ordered),
    [ordered, sel],
  );
  const startEq = inWin.length
    ? points.find((p) => p.trade._id === inWin[0]._id)!.equity - inWin[0].netProfit
    : run.initialBalance;
  const s = summarize(inWin, startEq);

  const cells = [
    { l: 'Trades', v: String(s.n) },
    { l: 'Win rate', v: s.n ? fmtPct(s.winRate) : '—' },
    { l: 'Profit factor', v: s.n ? (s.profitFactor == null ? '∞' : s.profitFactor.toFixed(2)) : '—' },
    { l: 'Net', v: fmtMoney(s.net), c: moneyClass(s.net) },
    { l: 'Expectancy', v: s.n ? fmtR(s.expR) : '—', c: moneyClass(s.expR) },
    { l: 'Max drawdown', v: s.n ? fmtPct(s.maxDrawdown) : '—' },
  ];

  return (
    <div className="stack">
      <div className="inline">
        {presets.map((p) => (
          <button key={p.name} className="btn2 btn-sm" aria-pressed={active === p.name}
            style={active === p.name ? { background: 'var(--surface-3)', borderColor: 'var(--line-strong)' } : undefined}
            onClick={() => { setActive(p.name); setSel(p.range); }}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="card" style={{ padding: '10px 6px 4px' }}>
        <EquityChart points={points} start={run.initialBalance} selection={sel}
          onSelect={(r) => { setSel(r); setActive(r ? '' : 'All'); }} />
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: -6 }}>
        Drag across the chart to choose a window; click once to clear it. Filled dots are winning trades, hollow dots losing ones.
      </p>
      <div className="strip six" style={{ marginBottom: 0 }}>
        {cells.map((c) => (
          <div key={c.l}><div className="l">{c.l}</div><div className={`v ${c.c ?? ''}`}>{c.v}</div></div>
        ))}
      </div>
      <div className="card">
        {inWin.length
          ? <TradeRows groups={[{ trades: inWin }]} limit={10} onOpen={onOpen} />
          : <div className="empty"><p>No trades closed in this window.</p></div>}
      </div>
    </div>
  );
}
