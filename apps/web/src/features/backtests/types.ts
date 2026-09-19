/**
 * Shapes returned by the gateway's /backtest routes. Declared here until
 * packages/contracts exists (see CLAUDE.md); keep them in step with
 * services/api-gateway/src/schemas/{backtest,trade}.schema.ts.
 */

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type IntrabarPolicy = 'pessimistic' | 'optimistic';
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
    bars: number;
    first_ts: number | null;
    last_ts: number | null;
    short_of_request: string | null;
  }[];
  failed: { symbol: string; timeframe: string; error: string }[];
  total_bars: number;
  elapsed_ms: number;
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
  };
}
