import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { SignalDirection } from './signal.schema';

export type TradeDocument = HydratedDocument<Trade>;

export enum TradeSource {
  /** Replayed inside a backtest. */
  BACKTEST = 'backtest',
  /** Taken by the user by hand, reconciled from MT5 history. */
  MANUAL = 'manual',
  /** Placed by the system. Not reachable in v1 — execution stays off (spec §6.4). */
  AUTOMATED = 'automated',
}

export enum TradeStatus { OPEN = 'open', CLOSED = 'closed' }

/** Matches the engine's `ExitReason` serialisation exactly. */
export enum TradeExitReason {
  STOP_LOSS = 'stop_loss',
  TAKE_PROFIT = 'take_profit',
  /** Still open when the backtest window ended; closed at the last bar. */
  END_OF_DATA = 'end_of_data',
}

/**
 * The journal. One row per trade regardless of where it came from, so manual
 * and backtested trades can be compared on the same axes.
 */
@Schema({ collection: 'trades', timestamps: true })
export class Trade {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Mt5Account', default: null, index: true })
  accountId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Strategy', default: null, index: true })
  strategyId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Signal', default: null })
  signalId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Backtest', default: null, index: true })
  backtestId: Types.ObjectId | null;

  /** MT5 position ticket, for trades reconciled from the terminal. */
  @Prop({ type: String, default: null, index: true })
  ticket: string | null;

  @Prop({ type: String, enum: TradeSource, required: true })
  source: TradeSource;

  @Prop({ required: true, index: true })
  symbol: string;

  @Prop({ type: String, enum: SignalDirection, required: true })
  direction: SignalDirection;

  @Prop({ type: String, enum: TradeStatus, default: TradeStatus.OPEN, index: true })
  status: TradeStatus;

  @Prop({ required: true }) volume: number;
  @Prop({ required: true }) entryPrice: number;
  @Prop({ type: Date, required: true }) entryTime: Date;

  @Prop({ default: null }) exitPrice: number | null;
  @Prop({ type: Date, default: null }) exitTime: Date | null;

  @Prop({ default: null }) stopLoss: number | null;
  @Prop({ default: null }) takeProfit: number | null;

  @Prop({ default: 0 }) grossProfit: number;
  @Prop({ default: 0 }) commission: number;
  @Prop({ default: 0 }) swap: number;
  @Prop({ default: 0 }) netProfit: number;
  @Prop({ default: null }) rMultiple: number | null;

  @Prop({ type: String, enum: TradeExitReason, default: null })
  exitReason: TradeExitReason | null;

  /** Stop and target both sat inside the exit bar, so the intrabar policy — not
   *  the data — decided the outcome. Counted by the Verdict view. */
  @Prop({ default: false }) ambiguousExit: boolean;

  @Prop({ default: null }) barsHeld: number | null;

  /** Furthest the trade went against the position before exit, in R (≥ 0).
   *  A stopped-out trade reads about 1.0. */
  @Prop({ default: null }) maeR: number | null;

  /** Furthest the trade went in its favour before exit, in R (≥ 0). A loser
   *  with a high value here was right about direction and wrong about exit. */
  @Prop({ default: null }) mfeR: number | null;

  /**
   * Why the trade was taken: the signal's `detail` map from the detector —
   * zone bounds, the broken level, flags, `detector_version`. Keys differ per
   * detector, so the results page renders whatever is here rather than a fixed
   * list, and a new strategy needs no schema change.
   */
  @Prop({ type: Map, of: Number, default: {} })
  detail: Map<string, number>;

  @Prop({ default: '' }) notes: string;
  @Prop({ type: [String], default: [] }) tags: string[];
}

export const TradeSchema = SchemaFactory.createForClass(Trade);
TradeSchema.index({ userId: 1, entryTime: -1 });
TradeSchema.index({ backtestId: 1, entryTime: 1 });
