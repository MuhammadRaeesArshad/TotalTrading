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

  @Prop({ default: '' }) notes: string;
  @Prop({ type: [String], default: [] }) tags: string[];
}

export const TradeSchema = SchemaFactory.createForClass(Trade);
TradeSchema.index({ userId: 1, entryTime: -1 });
TradeSchema.index({ backtestId: 1, entryTime: 1 });
