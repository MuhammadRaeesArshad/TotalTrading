import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Timeframe } from './strategy.schema';

export type SignalDocument = HydratedDocument<Signal>;

export enum SignalDirection { LONG = 'long', SHORT = 'short' }
export enum SignalState {
  FORMING = 'forming',
  ACTIVE = 'active',
  TRIGGERED = 'triggered',
  INVALIDATED = 'invalidated',
  EXPIRED = 'expired',
}

/**
 * One detected setup. Written only by strategy-engine and backtest-engine —
 * the gateway reads this collection, it never writes it (spec §6.6).
 */
@Schema({ collection: 'signals', timestamps: true })
export class Signal {
  @Prop({ type: Types.ObjectId, ref: 'Strategy', required: true, index: true })
  strategyId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Mt5Account', default: null, index: true })
  accountId: Types.ObjectId | null;

  @Prop({ required: true, index: true })
  symbol: string;

  @Prop({ type: String, enum: Timeframe, required: true })
  timeframe: Timeframe;

  @Prop({ type: String, enum: SignalDirection, required: true })
  direction: SignalDirection;

  @Prop({ type: String, enum: SignalState, default: SignalState.FORMING, index: true })
  state: SignalState;

  /** Open time of the bar the setup was detected on. */
  @Prop({ type: Date, required: true })
  barTime: Date;

  @Prop({ default: null }) entryPrice: number | null;
  @Prop({ default: null }) stopLoss: number | null;
  @Prop({ default: null }) takeProfit: number | null;
  @Prop({ default: null }) riskRewardRatio: number | null;

  /**
   * Whatever the detection function computed — zone bounds, confluence flags,
   * indicator values. Shape follows the finalized strategy (§3). This is the
   * payload handed to ai-analysis; the model never sees raw OHLC (§4).
   */
  @Prop({ type: Object, default: {} })
  detail: Record<string, unknown>;

  /** Set when produced by a backtest replay rather than the live scanner. */
  @Prop({ type: Types.ObjectId, ref: 'Backtest', default: null, index: true })
  backtestId: Types.ObjectId | null;
}

export const SignalSchema = SchemaFactory.createForClass(Signal);
SignalSchema.index({ strategyId: 1, symbol: 1, timeframe: 1, barTime: -1 });
SignalSchema.index({ state: 1, updatedAt: -1 });
