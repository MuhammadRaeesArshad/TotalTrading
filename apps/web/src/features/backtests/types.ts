/**
 * Shapes returned by the gateway's /backtest routes. Declared here until
 * packages/contracts exists (see CLAUDE.md); keep them in step with
 * services/api-gateway/src/schemas/{backtest,trade}.schema.ts.
 */

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type IntrabarPolicy = 'pessimistic' | 'optimistic';

export type CapitalMode = 'shared' | 'per_symbol';
export type SizingMode = 'fixed' | 'compound';
export type Direction = 'long' | 'short';
export type ExitReason = 'stop_loss' | 'take_profit' | 'end_of_data';

export interface RunMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  /** Percent, 0–100. */
  winRate: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  /** Null when there were no losing trades. */
  profitFactor: number | null;
  expectancy: number;
  expectancyR: number;
  maxDrawdown: number;
  /** Percent of the peak, 0–100. */
  maxDrawdownPct: number;
  sharpe: number | null;
  avgWin: number;
  avgLoss: number;
  longestLosingStreak: number;
  longestWinningStreak: number;
  finalEquity: number;
  ambiguousExits: number;
}

export interface SkipCounts {
  maxOpen: number;
  stopGapped: number;
  targetPassed: number;
  stopInsideCosts: number;
  belowMinVolume: number;
  noEntryBar: number;
}

export interface Run {
  _id: string;
  detector: string;
  detectorVersion: number | null;
  symbols: string[];
  /** Base timeframe first. */
  timeframes: string[];
  fromDate: string;
  toDate: string;
  initialBalance: number;
  riskPercentPerTrade: number;
  /** `shared`: one account for every pair. `per_symbol`: that balance each. */
  capital?: CapitalMode;
  /** What the risk was a percent of. Absent on runs stored before the choice. */
  sizing?: SizingMode;
  /** Put aside rather than deleted. Absent on runs stored before archiving. */
  archived?: boolean;
  intrabarPolicy: IntrabarPolicy;
  status: RunStatus;
  progressPct: number;
  engineVersion: string | null;
  metrics: RunMetrics | null;
  equityCurve?: { t: string; equity: number; drawdown: number }[];
  signalsGenerated: number;
  barsProcessed: number;
  elapsedMs: number;
  skipped: SkipCounts | null;
  /** The strategy settings this run used, frozen at run time. */
  rulesSnapshot?: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Trade {
  _id: string;
  symbol: string;
  direction: Direction;
  volume: number;
  entryPrice: number;
  entryTime: string;
  exitPrice: number;
  exitTime: string;
  stopLoss: number;
  takeProfit: number | null;
  grossProfit: number;
  commission: number;
  /** Overnight financing. Negative is a cost; zero if rates were unknown. */
  swap?: number;
  netProfit: number;
  rMultiple: number | null;
  exitReason: ExitReason | null;
  ambiguousExit: boolean;
  barsHeld: number | null;
  maeR: number | null;
  mfeR: number | null;
  /** The detector's reasoning for this trade. Keys vary by detector. */
  detail: Record<string, number>;
}

export interface Bars {
  symbol: string;
  timeframe: string;
  count: number;
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
}

export interface CachedSeries {
  symbol: string;
  timeframe: string;
  bars: number;
  first_ts: number | null;
  last_ts: number | null;
}

export interface ImportReport {
  imported: {
    symbol: string;
    timeframe: string;
    /** In the cache after this import. */
    bars: number;
    /** Added by this import — zero on a top-up with nothing new. */
    added?: number;
    incremental?: boolean;
    first_ts: number | null;
    last_ts: number | null;
    short_of_request: string | null;
  }[];
  failed: { symbol: string; timeframe: string; error: string }[];
  total_bars: number;
  elapsed_ms: number;
}

/** A history import running in the engine's background. */
export interface ImportJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  created_at: number;
  finished_at: number | null;
  series_total: number;
  series_done: number;
  bars_done: number;
  current: string;
  report?: ImportReport;
}

/** One tunable setting, as the strategy declares it. */
export interface ParamSpec {
  key: string;
  label: string;
  /** `pair_choice` is a per-pair override map, not a single value. */
  kind: 'int' | 'float' | 'bool' | 'choice' | 'pair_choice';
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
  options?: { value: string; label: string }[];
}

/** A strategy the engine can run, and everything its form needs. */
export interface Strategy {
  name: string;
  version: number;
  description: string;
  /** The timeframe it runs on. Empty means it takes whatever it is given. */
  timeframe: string;
  higher_timeframes: string[];
  params: ParamSpec[];
}

export interface StartRunInput {
  detector: string;
  symbols: string[];
  timeframe: string;
  higherTimeframes?: string[];
  fromTs: number;
  toTs: number;
  sim?: {
    riskPercent?: number;
    maxOpenPerSymbol?: number;
    intrabar?: IntrabarPolicy;
    initialBalance?: number;
    capital?: CapitalMode;
    sizing?: SizingMode;
  };
  /** The strategy's own settings. The engine validates them. */
  params?: Record<string, unknown>;
}

/** One run of a sweep: which setting it moved, and the result. */
export interface SweepCell {
  axis: string;
  value: unknown;
  runId: string | null;
  run: Run | null;
}

export interface Sweep {
  _id: string;
  label: string;
  detector: string;
  detectorVersion: number | null;
  baseParams: Record<string, unknown>;
  symbols: string[];
  timeframes: string[];
  fromDate: string;
  toDate: string;
  cells: SweepCell[];
  reusedCount: number;
  cancelled: boolean;
  createdAt: string;
}

export interface StartSweepInput extends StartRunInput {
  /** Values per numeric setting, endpoints included. */
  steps?: number;
  /** Only these settings; empty means every one that declares a range. */
  only?: string[];
}

/** One pair's contribution to a run, aggregated by the gateway. */
export interface PairRow {
  symbol: string;
  n: number;
  wins: number;
  /** Fraction, 0–1. */
  winRate: number;
  sumR: number;
  net: number;
}

export type Dimension = 'pair' | 'session' | 'year' | 'month' | 'direction' | 'setting';

/** One slice of trades across however many runs were in scope. */
export interface ExploreRow {
  keys: string[];
  /** Present when grouped by setting: the run this row came from. */
  runId?: string;
  n: number;
  wins: number;
  winRate: number;
  sumR: number;
  avgR: number;
  net: number;
  bestR: number;
  worstR: number;
}

export interface ExploreResult {
  rows: ExploreRow[];
  totals: { rows: number; n: number; wins: number; winRate: number; sumR: number; avgR: number; net: number };
  runs: number;
  by: Dimension[];
}

export interface ExploreQuery {
  runIds?: string[];
  sweepId?: string;
  by: Dimension[];
  minTrades?: number;
  pairs?: string[];
  sessions?: string[];
  side?: 'long' | 'short';
  result?: 'win' | 'loss';
  from?: string;
  to?: string;
}
