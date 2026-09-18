import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Timeframe } from './strategy.schema';

export type BacktestDocument = HydratedDocument<Backtest>;

export enum BacktestStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Schema({ _id: false })
export class BacktestMetrics {
  @Prop() totalTrades: number;
  @Prop() wins: number;
  @Prop() losses: number;
  @Prop() winRate: number;
  @Prop() netProfit: number;
  @Prop() profitFactor: number;
  @Prop() expectancy: number;
  @Prop() maxDrawdown: number;
  @Prop() maxDrawdownPct: number;
  @Prop() sharpe: number;
  @Prop() avgWin: number;
  @Prop() avgLoss: number;
  @Prop() longestLosingStreak: number;
}
export const BacktestMetricsSchema = SchemaFactory.createForClass(BacktestMetrics);

/** One point on the equity curve. Kept flat and small — these arrays get long. */
@Schema({ _id: false })
export class EquityPoint {
  @Prop({ type: Date }) t: Date;
  @Prop() equity: number;
  @Prop() drawdown: number;
}
export const EquityPointSchema = SchemaFactory.createForClass(EquityPoint);

/**
 * Written by backtest-engine only. The runner may be Python or Rust — the
 * document shape is the contract between them, so keep it engine-agnostic.
 */
@Schema({ collection: 'backtests', timestamps: true })
export class Backtest {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Strategy', required: true, index: true })
  strategyId: Types.ObjectId;

  /** Frozen copy of the rules as they were at run time — strategies get edited. */
  @Prop({ type: Object, default: {} })
  rulesSnapshot: Record<string, unknown>;

  @Prop({ default: 0 })
  rulesVersion: number;

  @Prop({ type: [String], default: [] })
  symbols: string[];

  @Prop({ type: [String], enum: Timeframe, default: [] })
  timeframes: Timeframe[];

  @Prop({ type: Date, required: true }) fromDate: Date;
  @Prop({ type: Date, required: true }) toDate: Date;

  @Prop({ default: 10000 }) initialBalance: number;
  @Prop({ default: 1 }) riskPercentPerTrade: number;

  @Prop({ type: String, enum: BacktestStatus, default: BacktestStatus.QUEUED, index: true })
  status: BacktestStatus;

  @Prop({ default: 0 })
  progressPct: number;

  /** Which implementation produced this run, e.g. "python-0.1.0" or "rust-0.1.0". */
  @Prop({ default: null })
  engineVersion: string | null;

  @Prop({ type: BacktestMetricsSchema, default: null })
  metrics: BacktestMetrics | null;

  @Prop({ type: [EquityPointSchema], default: [] })
  equityCurve: EquityPoint[];

  @Prop({ type: String, default: null })
  error: string | null;

  @Prop({ type: Date, default: null }) startedAt: Date | null;
  @Prop({ type: Date, default: null }) finishedAt: Date | null;
}

export const BacktestSchema = SchemaFactory.createForClass(Backtest);
BacktestSchema.index({ userId: 1, createdAt: -1 });
