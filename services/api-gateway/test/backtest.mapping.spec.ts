import { Types } from 'mongoose';
import {
  BARS_AFTER_EXIT, BARS_BEFORE_ENTRY, MAX_WINDOW_BARS, mapEquity, mapMetrics, mapTrade,
  tradeWindow,
} from '../src/backtest/backtest.mapping';
import type { EngineMetrics, EngineTrade } from '../src/backtest/backtest.client';
import { SignalDirection } from '../src/schemas/signal.schema';
import { TradeExitReason, TradeSource, TradeStatus } from '../src/schemas/trade.schema';

const trade: EngineTrade = {
  symbol: 'EURUSD',
  direction: 'short',
  volume: 0.5,
  entry_time: 1_700_000_000,
  entry_price: 1.1,
  exit_time: 1_700_036_000,
  exit_price: 1.096,
  stop_loss: 1.102,
  take_profit: 1.096,
  exit_reason: 'take_profit',
  gross_profit: 200,
  commission: 3.5,
  net_profit: 196.5,
  r_multiple: 1.96,
  ambiguous_exit: false,
  bars_held: 10,
  mae_r: 0.4,
  mfe_r: 2,
  detail: { zone_high: 1.1015, zone_low: 1.1004, detector_version: 1 },
};

const ids = {
  userId: new Types.ObjectId(),
  backtestId: new Types.ObjectId(),
  strategyId: null,
};

describe('mapTrade', () => {
  it('converts engine seconds to dates, not milliseconds', () => {
    const doc = mapTrade(trade, ids);
    expect(doc.entryTime!.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(doc.exitTime!.getTime() - doc.entryTime!.getTime()).toBe(36_000_000);
  });

  it('carries direction, exit reason and the quality fields', () => {
    const doc = mapTrade(trade, ids);
    expect(doc.direction).toBe(SignalDirection.SHORT);
    expect(doc.exitReason).toBe(TradeExitReason.TAKE_PROFIT);
    expect(doc.source).toBe(TradeSource.BACKTEST);
    expect(doc.status).toBe(TradeStatus.CLOSED);
    expect(doc.maeR).toBe(0.4);
    expect(doc.mfeR).toBe(2);
    expect(doc.detail!.get('zone_high')).toBe(1.1015);
    expect(doc.detail!.get('detector_version')).toBe(1);
  });

  it('stores a non-finite R as null, never as zero', () => {
    const doc = mapTrade({ ...trade, r_multiple: Number.NaN }, ids);
    expect(doc.rMultiple).toBeNull();
  });
});

describe('mapMetrics', () => {
  const metrics: EngineMetrics = {
    total_trades: 10, wins: 4, losses: 6, win_rate: 0.4, net_profit: 120,
    gross_profit: 800, gross_loss: 680, profit_factor: null, expectancy: 12,
    expectancy_r: 0.15, max_drawdown: 300, max_drawdown_pct: 0.03, sharpe: 1.1,
    avg_win: 200, avg_loss: 113, longest_losing_streak: 3, longest_winning_streak: 2,
    final_equity: 10_120, ambiguous_exits: 1,
  };

  it('keeps an infinite profit factor as null, not a fake number', () => {
    expect(mapMetrics(metrics).profitFactor).toBeNull();
  });

  it('carries the fields the Verdict and Ledger read', () => {
    const m = mapMetrics(metrics);
    expect(m.grossProfit).toBe(800);
    expect(m.grossLoss).toBe(680);
    expect(m.expectancyR).toBe(0.15);
    expect(m.ambiguousExits).toBe(1);
  });
});

describe('mapEquity', () => {
  it('turns exit seconds into dates and leaves drawdown in money', () => {
    const [p] = mapEquity([{ t: 1_700_000_000, equity: 10_050, drawdown: 25 }]);
    expect(p.t.getTime()).toBe(1_700_000_000_000);
    expect(p.drawdown).toBe(25);
  });
});

describe('tradeWindow', () => {
  const entry = new Date(1_700_000_000_000);
  const exit = new Date(1_700_000_000_000 + 10 * 3_600_000);

  it('adds context before entry and after exit, in bars of the run timeframe', () => {
    const w = tradeWindow(entry, exit, 'H1');
    expect(w.fromTs).toBe(1_700_000_000 - BARS_BEFORE_ENTRY * 3_600);
    expect(w.toTs).toBe(1_700_000_000 + 10 * 3_600 + BARS_AFTER_EXIT * 3_600);
  });

  it('clips a very long trade at the front to stay under the engine cap', () => {
    const longExit = new Date(entry.getTime() + 20_000 * 900_000);
    const w = tradeWindow(entry, longExit, 'M15');
    expect((w.toTs - w.fromTs) / 900).toBe(MAX_WINDOW_BARS);
  });
});
