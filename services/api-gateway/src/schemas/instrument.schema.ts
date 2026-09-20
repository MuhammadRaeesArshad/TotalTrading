import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type InstrumentDocument = HydratedDocument<Instrument>;

export enum InstrumentClass {
  MAJOR = 'major',
  MINOR = 'minor',
  EXOTIC = 'exotic',
  /** Spot gold. Priced and sized unlike a currency pair — see the engine's
   *  `default_sim_for`, which gives it its own point size. */
  METAL = 'metal',
  OTHER = 'other',
}

/**
 * A tradable symbol as the connected broker spells it. Populated from
 * mt5-connector on account connect — never hardcoded, because symbol naming
 * varies between brokers (EURUSD vs EURUSD.r vs EURUSDm).
 */
@Schema({ collection: 'instruments', timestamps: true })
export class Instrument {
  @Prop({ type: Types.ObjectId, ref: 'Mt5Account', required: true, index: true })
  accountId: Types.ObjectId;

  /** Broker-specific symbol string, used verbatim in MT5 calls. */
  @Prop({ required: true, trim: true })
  symbol: string;

  /** Normalised 6-letter pair (EURUSD) for grouping across brokers. Null if not an FX pair. */
  @Prop({ type: String, default: null, index: true })
  normalizedPair: string | null;

  @Prop({ type: String, enum: InstrumentClass, default: InstrumentClass.OTHER })
  instrumentClass: InstrumentClass;

  @Prop({ default: null }) baseCurrency: string | null;
  @Prop({ default: null }) quoteCurrency: string | null;
  @Prop({ default: null }) digits: number | null;
  @Prop({ default: null }) pointSize: number | null;
  @Prop({ default: null }) contractSize: number | null;
  @Prop({ default: null }) volumeMin: number | null;
  @Prop({ default: null }) volumeMax: number | null;
  @Prop({ default: null }) volumeStep: number | null;

  /** Whether the symbol is visible in Market Watch — hidden symbols return no candles. */
  @Prop({ default: false })
  selected: boolean;

  @Prop({ default: true })
  tradable: boolean;
}

export const InstrumentSchema = SchemaFactory.createForClass(Instrument);
InstrumentSchema.index({ accountId: 1, symbol: 1 }, { unique: true });
