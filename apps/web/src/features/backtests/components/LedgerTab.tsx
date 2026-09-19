import { useMemo, useState } from 'react';
import type { Run, Trade } from '../types';
import { byExit, isWin, rOf, summarize } from '../stats';
import { fmtDate, fmtMoney, fmtPct, fmtR, money0, moneyClass } from '../fmt';
import { TradeRows } from './TradeRows';

type Key = 'net' | 'wr' | 'pf' | 'exp' | 'dd';

/**
 * Pick a metric; see its arithmetic with this run's numbers, and the trades
 * that made it. The headline figures come from the engine; the decomposition
 * is recomputed from the stored trades, so the two check each other.
 */
export function LedgerTab({ run, trades, onOpen }: { run: Run; trades: Trade[]; onOpen: (id: string) => void }) {
  const [key, setKey] = useState<Key>('pf');
  const m = run.metrics!;
  const s = useMemo(() => summarize(trades, run.initialBalance), [trades, run.initialBalance]);
  const wins = useMemo(() => trades.filter(isWin).sort((a, b) => b.netProfit - a.netProfit), [trades]);
  const losses = useMemo(() => trades.filter((t) => !isWin(t)).sort((a, b) => a.netProfit - b.netProfit), [trades]);
  const ordered = useMemo(() => [...trades].sort(byExit), [trades]);

  let peakEq = run.initialBalance;
  for (let i = 0; i <= s.ddPeak; i++) peakEq += ordered[i]?.netProfit ?? 0;
  let troughEq = peakEq;
  for (let i = s.ddPeak + 1; i <= s.ddTrough; i++) troughEq += ordered[i]?.netProfit ?? 0;
  const ddTrades = s.ddTrough >= 0 ? ordered.slice(s.ddPeak + 1, s.ddTrough + 1) : [];
  const ddStart = s.ddPeak >= 0 ? ordered[s.ddPeak] : ordered[0];

  const tiles: Record<Key, { label: string; value: string; cls?: string }> = {
    net: { label: 'Net result', value: fmtMoney(m.netProfit), cls: moneyClass(m.netProfit) },
    wr: { label: 'Win rate', value: fmtPct(m.winRate / 100) },
    pf: { label: 'Profit factor', value: m.profitFactor == null ? '∞' : m.profitFactor.toFixed(2) },
    exp: { label: 'Expectancy', value: fmtR(m.expectancyR), cls: moneyClass(m.expectancyR) },
    dd: { label: 'Max drawdown', value: `${m.maxDrawdownPct.toFixed(1)}%` },
  };

  const lossShare = losses.length / Math.max(trades.length, 1);

  const body: Record<Key, { eq: React.ReactNode; explain: string; rows: { label?: string; trades: Trade[] }[] }> = {
    net: {
      eq: <>{money0(m.grossProfit)} won<span className="op">−</span>{money0(m.grossLoss)} lost<span className={`res ${moneyClass(m.netProfit)}`}>{fmtMoney(m.netProfit)}</span></>,
      explain: `Across ${m.totalTrades} trades, each risking ${run.riskPercentPerTrade}% of the equity at the time, so results compound.`,
      rows: [{ label: 'Largest wins', trades: wins }, { label: 'Largest losses', trades: losses }],
    },
    wr: {
      eq: <><b>{m.wins}</b> winners<span className="op">÷</span><b>{m.totalTrades}</b> trades<span className="res">{fmtPct(m.winRate / 100)}</span></>,
      explain: `A 2R target breaks even at 33.3% before costs. ${m.ambiguousExits} ambiguous exits were scored as losses.`,
      rows: [{ label: `Winners · ${wins.length}`, trades: wins }, { label: `Losers · ${losses.length}`, trades: losses }],
    },
    pf: {
      eq: <>Gross profit <b>{money0(m.grossProfit)}</b><br /><span className="op">÷</span>Gross loss <b>{money0(m.grossLoss)}</b><span className="res">{m.profitFactor == null ? '∞' : m.profitFactor.toFixed(2)}</span></>,
      explain: 'Every dollar lost bought this many back. Above 1.0 is profitable; the Verdict asks for 1.30 to leave room for live slippage.',
      rows: [{ label: 'Gross profit — winners', trades: wins }, { label: 'Gross loss — losers', trades: losses }],
    },
    exp: {
      eq: <>(<b>{fmtPct(s.winRate)}</b> × {fmtR(s.avgWinR)})<br /><span className="op">−</span>(<b>{fmtPct(lossShare)}</b> × {s.avgLossR.toFixed(2)}R)<span className={`res ${moneyClass(s.expR)}`}>{fmtR(s.expR)}</span></>,
      explain: 'The average trade in multiples of what it risked. Costs live here: winners land a little under target, losers a little over 1R.',
      rows: [{ label: `Winners · avg ${fmtR(s.avgWinR)}`, trades: [...wins].sort((a, b) => rOf(b) - rOf(a)) }, { label: `Losers · avg −${s.avgLossR.toFixed(2)}R`, trades: [...losses].sort((a, b) => rOf(a) - rOf(b)) }],
    },
    dd: {
      eq: ddStart
        ? <>Peak <b>{money0(peakEq)}</b> · {fmtDate(ddStart.exitTime)}<br /><span className="op">→</span>Trough <b>{money0(troughEq)}</b> · {fmtDate(ordered[s.ddTrough]?.exitTime ?? ddStart.exitTime)}<span className="res loss">−{m.maxDrawdownPct.toFixed(1)}%</span></>
        : <>No drawdown.</>,
      explain: `The deepest fall from a high, on closed trades. ${ddTrades.filter((t) => !isWin(t)).length} of the ${ddTrades.length} trades between the peak and the trough lost.`,
      rows: [{ trades: ddTrades }],
    },
  };

  const b = body[key];
  return (
    <>
      <div className="tiles" role="tablist" aria-label="Metrics">
        {(Object.keys(tiles) as Key[]).map((k) => (
          <button key={k} className="tile" role="tab" aria-selected={k === key} onClick={() => setKey(k)}>
            <span className="l">{tiles[k].label}</span>
            <span className={`v ${tiles[k].cls ?? ''}`}>{tiles[k].value}</span>
          </button>
        ))}
      </div>
      <div className="ledger-grid">
        <div className="card card-b stack">
          <p style={{ fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>How it was calculated</p>
          <p className="eq">{b.eq}</p>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>{b.explain}</p>
        </div>
        <div className="card">
          <TradeRows groups={b.rows} limit={14} onOpen={onOpen} />
        </div>
      </div>
    </>
  );
}
