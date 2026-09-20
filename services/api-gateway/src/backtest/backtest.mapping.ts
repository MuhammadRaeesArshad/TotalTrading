import { Types } from 'mongoose';
import { SignalDirection } from '../schemas/signal.schema';
import { TradeExitReason, TradeSource, TradeStatus } from '../schemas/trade.schema';
import type { BacktestMetrics, EquityPoint } from '../schemas/backtest.schema';
import type { Trade } from '../schemas/trade.schema';
import type {
  EngineMetrics, EngineRunResult, EngineSkipCounts, EngineTrade,
} from './backtest.client';

/**
 * Engine wire format → Mongo documents. Pure functions, so the translation is
 * tested without a database — it is where a unit mix-up (seconds vs
 * milliseconds, money vs percent) would silently corrupt every stored run.
 */

/** Seconds per bar, for sizing the window of bars drawn around a trade. */
export const TIMEFRAME_SECONDS: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1_800, H1: 3_600, H4: 14_400, D1: 86_400, W1: 604_800,
};

/** Bars of context before entry and after exit on a trade's chart. */
export const BARS_BEFORE_ENTRY = 80;
export const BARS_AFTER_EXIT = 25;
/** Stay under the engine's per-request cap with room to spare. */
export const MAX_WINDOW_BARS = 4_500;

/** Engine timestamps are unix seconds. */
export const toDate = (seconds: number): Date => new Date(seconds * 1_000);

/** Infinity and NaN arrive as null from serde; store them as null, not 0. */
const finiteOrNull = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function mapMetrics(m: EngineMetrics): BacktestMetrics {
  return {
    totalTrades: m.total_trades,
    wins: m.wins,
    losses: m.losses,
    winRate: m.win_rate,
    netProfit: m.net_profit,
    grossProfit: m.gross_profit,
    grossLoss: m.gross_loss,
    profitFactor: finiteOrNull(m.profit_factor),
    expectancy: m.expectancy,
    expectancyR: m.expectancy_r,
    maxDrawdown: m.max_drawdown,
    maxDrawdownPct: m.max_drawdown_pct,
    sharpe: finiteOrNull(m.sharpe),
    avgWin: m.avg_win,
    avgLoss: m.avg_loss,
    longestLosingStreak: m.longest_losing_streak,
    longestWinningStreak: m.longest_winning_streak,
    finalEquity: m.final_equity,
    ambiguousExits: m.ambiguous_exits,
  } as BacktestMetrics;
}

export function mapSkipped(s: EngineSkipCounts | undefined) {
  if (!s) return null;
  return {
    maxOpen: s.max_open,
    stopGapped: s.stop_gapped,
    targetPassed: s.target_passed ?? 0,
    stopInsideCosts: s.stop_inside_costs,
    belowMinVolume: s.below_min_volume,
    noEntryBar: s.no_entry_bar,
  };
}

export function mapEquity(curve: EngineRunResult['equity_curve']): EquityPoint[] {
  return curve.map((p) => ({ t: toDate(p.t), equity: p.equity, drawdown: p.drawdown }));
}

const EXIT_REASONS: Record<EngineTrade['exit_reason'], TradeExitReason> = {
  stop_loss: TradeExitReason.STOP_LOSS,
  take_profit: TradeExitReason.TAKE_PROFIT,
  end_of_data: TradeExitReason.END_OF_DATA,
};

export function mapTrade(
  t: EngineTrade,
  ids: { userId: Types.ObjectId; backtestId: Types.ObjectId; strategyId: Types.ObjectId | null },
): Partial<Trade> {
  return {
    userId: ids.userId,
    backtestId: ids.backtestId,
    strategyId: ids.strategyId,
    accountId: null,
    signalId: null,
    ticket: null,
    source: TradeSource.BACKTEST,
    symbol: t.symbol,
    direction: t.direction === 'long' ? SignalDirection.LONG : SignalDirection.SHORT,
    status: TradeStatus.CLOSED,
    volume: t.volume,
    entryPrice: t.entry_price,
    entryTime: toDate(t.entry_time),
    exitPrice: t.exit_price,
    exitTime: toDate(t.exit_time),
    stopLoss: t.stop_loss,
    takeProfit: t.take_profit,
    grossProfit: t.gross_profit,
    commission: t.commission,
    swap: t.swap ?? 0,
    netProfit: t.net_profit,
    rMultiple: finiteOrNull(t.r_multiple),
    exitReason: EXIT_REASONS[t.exit_reason] ?? null,
    ambiguousExit: t.ambiguous_exit,
    barsHeld: t.bars_held,
    maeR: finiteOrNull(t.mae_r),
    mfeR: finiteOrNull(t.mfe_r),
    detail: new Map(Object.entries(t.detail ?? {})),
  };
}

/**
 * The span of bars to draw around a trade: context before entry so the setup
 * is visible, and a little after exit. Long trades are clipped at the front,
 * because the entry and exit matter more than the far past.
 */
export function tradeWindow(
  entry: Date,
  exit: Date | null,
  timeframe: string,
): { fromTs: number; toTs: number } {
  const step = TIMEFRAME_SECONDS[timeframe] ?? 3_600;
  const entryTs = Math.floor(entry.getTime() / 1_000);
  const exitTs = Math.floor((exit ?? entry).getTime() / 1_000);
  const toTs = exitTs + BARS_AFTER_EXIT * step;
  let fromTs = entryTs - BARS_BEFORE_ENTRY * step;
  if ((toTs - fromTs) / step > MAX_WINDOW_BARS) {
    fromTs = toTs - MAX_WINDOW_BARS * step;
  }
  return { fromTs, toTs };
}
