/**
 * Everything the results page derives from a run's trades.
 *
 * Pure and dependency-free on purpose: `checks/stats.check.ts` runs it under
 * plain Node, so the numbers on screen have a test behind them without a test
 * framework. Uses only erasable TypeScript (no enums) for the same reason.
 *
 * Conventions: rates here are fractions (0–1). The engine's stored metrics use
 * percent (0–100) — convert at the edge with `pct()` from format, never mix.
 */
import type { Run, Trade } from './types';

// ------------------------------------------------------------------ sessions

export const SESSIONS = [
  { name: 'Asia', from: 0, to: 7 },
  { name: 'London', from: 7, to: 12 },
  { name: 'Overlap', from: 12, to: 16 },
  { name: 'New York', from: 16, to: 21 },
  { name: 'Late', from: 21, to: 24 },
] as const;
export type SessionName = (typeof SESSIONS)[number]['name'];

/** By entry hour in UTC. London–New York overlap is its own bucket. */
export function sessionOf(iso: string): SessionName {
  const h = new Date(iso).getUTCHours();
  for (const s of SESSIONS) if (h >= s.from && h < s.to) return s.name;
  return 'Late';
}

export function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const yearOf = (iso: string) => new Date(iso).getUTCFullYear();

// ------------------------------------------------------------------ basics

export const rOf = (t: Trade) => (t.rMultiple ?? 0);
/** Same rule as the engine: a trade that nets zero or better is a win. */
export const isWin = (t: Trade) => t.netProfit >= 0;

export const byExit = (a: Trade, b: Trade) =>
  new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime();

export interface Summary {
  n: number;
  wins: number;
  losses: number;
  /** Fraction, 0–1. */
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  /** Null when there are no losses. */
  profitFactor: number | null;
  net: number;
  sumR: number;
  expR: number;
  avgWinR: number;
  /** Positive number: the average loser's size in R. */
  avgLossR: number;
  /** Fraction of the peak, 0–1. */
  maxDrawdown: number;
  /** Indices into the exit-ordered list; -1 when the peak was the start. */
  ddPeak: number;
  ddTrough: number;
}

/**
 * Summary of any subset of trades. Drawdown is walked in exit order from
 * `startEquity`, which should be the equity just before the subset's first
 * trade — the run's initial balance for the whole run.
 */
/**
 * What the portfolio actually started with.
 *
 * Under `per_symbol` each pair gets its own copy of `initialBalance`, so a
 * 28-pair run deployed 28 times it. Every percentage this file recomputes —
 * return, drawdown — has to be measured against that, or the tabs disagree
 * with the engine's own metrics by a factor of the pair count.
 */
export function deployedCapital(run: Run): number {
  return run.capital === 'per_symbol'
    ? run.initialBalance * Math.max(1, run.symbols.length)
    : run.initialBalance;
}

export function summarize(trades: Trade[], startEquity: number): Summary {
  const list = [...trades].sort(byExit);
  let wins = 0, grossProfit = 0, grossLoss = 0, sumR = 0, winR = 0, lossR = 0;
  let equity = startEquity, peak = startEquity, peakIdx = -1;
  let maxDrawdown = 0, ddPeak = -1, ddTrough = -1;

  list.forEach((t, i) => {
    const r = rOf(t);
    sumR += r;
    if (isWin(t)) { wins++; grossProfit += t.netProfit; winR += r; }
    else { grossLoss += -t.netProfit; lossR += -r; }

    equity += t.netProfit;
    if (equity > peak) { peak = equity; peakIdx = i; }
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDrawdown) { maxDrawdown = dd; ddPeak = peakIdx; ddTrough = i; }
  });

  const n = list.length;
  const losses = n - wins;
  return {
    n,
    wins,
    losses,
    winRate: n ? wins / n : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    net: grossProfit - grossLoss,
    sumR,
    expR: n ? sumR / n : 0,
    avgWinR: wins ? winR / wins : 0,
    avgLossR: losses ? lossR / losses : 0,
    maxDrawdown,
    ddPeak,
    ddTrough,
  };
}

/** Equity after each trade, in exit order, from the run's starting balance. */
export function equityPath(trades: Trade[], startEquity: number) {
  let equity = startEquity, peak = startEquity;
  return [...trades].sort(byExit).map((t) => {
    equity += t.netProfit;
    peak = Math.max(peak, equity);
    return { t: new Date(t.exitTime).getTime(), equity, drawdown: peak > 0 ? (peak - equity) / peak : 0, trade: t };
  });
}

// ------------------------------------------------------------------ groupings

export interface Group { key: string; n: number; wins: number; winRate: number; sumR: number; net: number }

export function groupBy(trades: Trade[], keyOf: (t: Trade) => string): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const t of trades) {
    const k = keyOf(t);
    const g = out.get(k) ?? { key: k, n: 0, wins: 0, winRate: 0, sumR: 0, net: 0 };
    g.n++;
    if (isWin(t)) g.wins++;
    g.sumR += rOf(t);
    g.net += t.netProfit;
    g.winRate = g.wins / g.n;
    out.set(k, g);
  }
  return out;
}

/** Half-R bins from -1.5 to +2.5 and beyond, open-ended at both ends. */
export const R_BINS: [number, number][] = [
  [-Infinity, -1.5], [-1.5, -1], [-1, -0.5], [-0.5, 0],
  [0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, 2.5], [2.5, Infinity],
];

export function rHistogram(trades: Trade[]): number[] {
  return R_BINS.map(([lo, hi]) => trades.filter((t) => rOf(t) >= lo && rOf(t) < hi).length);
}

// ------------------------------------------------------------------ verdict

export type CriterionStatus = 'pass' | 'fail' | 'unknown';

export interface Criterion {
  id: string;
  title: string;
  why: string;
  threshold: string;
  actual: string;
  status: CriterionStatus;
}

/** Defaults until per-strategy criteria land with strategy configs. */
export const DEFAULT_CRITERIA = {
  minTrades: 100,
  minProfitFactor: 1.3,
  minExpectancyR: 0.1,
  maxDrawdownPct: 15,
  minTradesPerPair: 30,
  maxAmbiguousPct: 5,
  maxIntrabarPfGap: 0.25,
} as const;

const f2 = (v: number) => v.toFixed(2);
const sgnR = (v: number, dp = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}R`;

/**
 * Judges a completed run against the criteria. `optimistic` is the same run
 * repeated with the optimistic intrabar policy, when one exists; without it
 * that criterion is reported as unknown rather than guessed.
 */
export function verdict(
  run: Run,
  trades: Trade[],
  /** What the view being judged started with — filtering changes it. */
  capital: number,
  optimistic: Run | null = null,
): Criterion[] {
  const c = DEFAULT_CRITERIA;
  const m = run.metrics;
  const s = summarize(trades, capital);
  const n = m?.totalTrades ?? s.n;
  const pf = m ? m.profitFactor : s.profitFactor;
  const expR = m?.expectancyR ?? s.expR;
  const ddPct = m?.maxDrawdownPct ?? s.maxDrawdown * 100;

  const years = [...groupBy(trades, (t) => String(yearOf(t.exitTime))).values()]
    .sort((a, b) => a.key.localeCompare(b.key));
  const top5 = [...trades].sort((a, b) => rOf(b) - rOf(a)).slice(0, 5);
  const withoutTop5 = s.sumR - top5.reduce((a, t) => a + rOf(t), 0);
  const pairs = [...groupBy(trades, (t) => t.symbol).values()];
  const thinnest = pairs.reduce<Group | null>((a, g) => (!a || g.n < a.n ? g : a), null);
  const ambiguous = m?.ambiguousExits ?? trades.filter((t) => t.ambiguousExit).length;
  const ambPct = n ? (ambiguous / n) * 100 : 0;
  const optPf = optimistic?.metrics?.profitFactor ?? null;

  return [
    {
      id: 'sample', title: 'Enough trades to mean something',
      why: 'Below this, one lucky month can carry the whole result.',
      threshold: `≥ ${c.minTrades}`, actual: String(n),
      status: n >= c.minTrades ? 'pass' : 'fail',
    },
    {
      id: 'pf', title: 'Profit factor',
      why: `Gross profit over gross loss. Above 1.0 is profitable; the margin leaves room for live slippage.`,
      threshold: `≥ ${f2(c.minProfitFactor)}`, actual: pf == null ? 'no losses' : f2(pf),
      status: pf == null ? 'unknown' : pf >= c.minProfitFactor ? 'pass' : 'fail',
    },
    {
      id: 'exp', title: 'Expectancy per trade',
      why: 'The average trade, in multiples of what it risked.',
      threshold: `≥ ${sgnR(c.minExpectancyR)}`, actual: sgnR(expR),
      status: expR >= c.minExpectancyR ? 'pass' : 'fail',
    },
    {
      id: 'dd', title: 'Maximum drawdown',
      why: 'The deepest fall from a high, on closed trades.',
      threshold: `≤ ${c.maxDrawdownPct}%`, actual: `${ddPct.toFixed(1)}%`,
      status: ddPct <= c.maxDrawdownPct ? 'pass' : 'fail',
    },
    {
      id: 'years', title: 'Profitable in every calendar year',
      why: 'A result only one year produced is a regime, not an edge.',
      threshold: 'every year', actual: `${years.filter((y) => y.net > 0).length} of ${years.length}`,
      status: years.length === 0 ? 'unknown' : years.every((y) => y.net > 0) ? 'pass' : 'fail',
    },
    {
      id: 'top5', title: 'Not carried by its five best trades',
      why: `Remove the five biggest winners and ${sgnR(withoutTop5, 1)} remains.`,
      threshold: '> 0R', actual: sgnR(withoutTop5, 1),
      status: trades.length === 0 ? 'unknown' : withoutTop5 > 0 ? 'pass' : 'fail',
    },
    {
      id: 'perpair', title: 'Enough trades on every pair',
      why: thinnest ? `Thinnest is ${thinnest.key} with ${thinnest.n}. Per-pair conclusions below this are noise.` : 'No trades.',
      threshold: `≥ ${c.minTradesPerPair} each`, actual: thinnest ? `min ${thinnest.n}` : '—',
      status: !thinnest ? 'unknown' : thinnest.n >= c.minTradesPerPair ? 'pass' : 'fail',
    },
    {
      id: 'amb', title: 'Few exits decided by the tie-break',
      why: `${ambiguous} trades had stop and target inside one bar and were scored against the strategy.`,
      threshold: `≤ ${c.maxAmbiguousPct}%`, actual: `${ambPct.toFixed(1)}%`,
      status: ambPct <= c.maxAmbiguousPct ? 'pass' : 'fail',
    },
    {
      id: 'intrabar', title: 'Holds if ambiguous bars went the other way',
      why: optPf == null || pf == null
        ? 'Needs the same run repeated with the optimistic intrabar policy.'
        : `Profit factor ${f2(pf)} pessimistic, ${f2(optPf)} optimistic. A small gap means the edge does not live in ambiguous bars.`,
      threshold: `gap ≤ ${f2(c.maxIntrabarPfGap)}`,
      actual: optPf == null || pf == null ? 'not run' : f2(optPf - pf),
      status: optPf == null || pf == null ? 'unknown' : optPf - pf <= c.maxIntrabarPfGap ? 'pass' : 'fail',
    },
  ];
}
