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
  /** Percent, 0–100 — not a fraction. The engine reports it this way. */
  @Prop() winRate: number;
  @Prop() netProfit: number;
  @Prop() profitFactor: number;
  @Prop() expectancy: number;
  /** In account currency. */
  @Prop() maxDrawdown: number;
  /** Percent of the peak, 0–100. */
  @Prop() maxDrawdownPct: number;
  @Prop() sharpe: number;
  @Prop() avgWin: number;
  @Prop() avgLoss: number;
  @Prop() longestLosingStreak: number;
  @Prop() longestWinningStreak: number;
  @Prop() grossProfit: number;
  @Prop() grossLoss: number;
  /** Average trade in multiples of risk. The one cross-pair comparable figure. */
  @Prop() expectancyR: number;
  @Prop() finalEquity: number;
  /** Trades whose outcome the intrabar policy decided. */
  @Prop() ambiguousExits: number;
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
 * One engine run. The engine computes it and holds no database connection;
 * the gateway persists it (rule 3). Trades live in the `trades` collection,
 * keyed by `backtestId`, rather than inline — a run can hold thousands.
 */
@Schema({ collection: 'backtests', timestamps: true })
export class Backtest {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  /** Null when a run targets a detector directly rather than a saved strategy. */
  @Prop({ type: Types.ObjectId, ref: 'Strategy', default: null, index: true })
  strategyId: Types.ObjectId | null;

  /** Registry name of the detector that ran, e.g. `smc_ob`. */
  @Prop({ required: true, index: true })
  detector: string;

  /**
   * The detector's rule version (rule 6). Runs from different versions are not
   * comparable and must not be charted together.
   */
  @Prop({ default: null, index: true })
  detectorVersion: number | null;

  /** The engine's job id, for polling progress while the run is in flight. */
  @Prop({ type: String, default: null, index: true })
  engineRunId: string | null;

  /** Frozen copy of the rules as they were at run time — strategies get edited. */
  @Prop({ type: Object, default: {} })
  rulesSnapshot: Record<string, unknown>;

  @Prop({ default: 0 })
  rulesVersion: number;

  @Prop({ type: [String], default: [] })
  symbols: string[];

  /** Base timeframe first, then any higher timeframes the detector reads. */
  @Prop({ type: [String], enum: Timeframe, default: [] })
  timeframes: Timeframe[];

  /** How a bar holding both stop and target was scored. Pessimistic is the
   *  default and the only one to trust (rule 5). */
  @Prop({ type: String, enum: ['pessimistic', 'optimistic'], default: 'pessimistic' })
  intrabarPolicy: 'pessimistic' | 'optimistic';

  @Prop({ type: Date, required: true }) fromDate: Date;
  @Prop({ type: Date, required: true }) toDate: Date;

  @Prop({ default: 10000 }) initialBalance: number;
  @Prop({ default: 1 }) riskPercentPerTrade: number;

  /** Whether `initialBalance` was one account for the whole run or one per
   *  pair. Runs stored before this field existed were shared, which is the
   *  default, so they still read correctly. */
  @Prop({ type: String, enum: ['shared', 'per_symbol'], default: 'shared' })
  capital: 'shared' | 'per_symbol';

  /** What the risk was a percent of. `fixed` is the default: the account
   *  cannot run out, so every signal is tested rather than skipped once a
   *  compounding balance reaches zero. */
  @Prop({ type: String, enum: ['fixed', 'compound'], default: 'fixed' })
  sizing: 'fixed' | 'compound';

  @Prop({ type: String, enum: BacktestStatus, default: BacktestStatus.QUEUED, index: true })
  status: BacktestStatus;

  /** Archived runs stay on file and keep their trades; they are just out of
   *  the way. Deleting is the other option, and it is not reversible. */
  @Prop({ type: Boolean, default: false, index: true })
  archived: boolean;

  /** Hash of everything that decides this result. A completed run with the
   *  same one is the same answer, so it is returned instead of running again.
   *  See `backtest.fingerprint.ts`. */
  @Prop({ type: String, index: true, default: null })
  fingerprint: string | null;

  @Prop({ default: 0 })
  progressPct: number;

  /** Engine build that produced this run, e.g. "rust-0.1.0". */
  @Prop({ default: null })
  engineVersion: string | null;

  @Prop({ type: BacktestMetricsSchema, default: null })
  metrics: BacktestMetrics | null;

  @Prop({ type: [EquityPointSchema], default: [] })
  equityCurve: EquityPoint[];

  @Prop({ default: 0 }) signalsGenerated: number;

  /**
   * Signals that did not become trades, by reason. Signals minus trades should
   * always equal the sum of these; a run that drops setups silently cannot be
   * judged.
   */
  @Prop({ type: Object, default: null })
  skipped: {
    maxOpen: number;
    stopGapped: number;
    targetPassed: number;
    stopInsideCosts: number;
    belowMinVolume: number;
    noEntryBar: number;
  } | null;
  @Prop({ default: 0 }) barsProcessed: number;
  @Prop({ default: 0 }) elapsedMs: number;

  @Prop({ type: String, default: null })
  error: string | null;

  @Prop({ type: Date, default: null }) startedAt: Date | null;
  @Prop({ type: Date, default: null }) finishedAt: Date | null;
}

export const BacktestSchema = SchemaFactory.createForClass(Backtest);
BacktestSchema.index({ userId: 1, createdAt: -1 });
// The cache lookup: one user's completed run with this exact fingerprint.
BacktestSchema.index({ userId: 1, fingerprint: 1, status: 1 });
