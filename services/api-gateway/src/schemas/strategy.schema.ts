import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type StrategyDocument = HydratedDocument<Strategy>;

export enum Timeframe {
  M1 = 'M1', M5 = 'M5', M15 = 'M15', M30 = 'M30',
  H1 = 'H1', H4 = 'H4', D1 = 'D1', W1 = 'W1', MN1 = 'MN1',
}

/**
 * A named rule set. The rules themselves are deliberately untyped for now:
 * the strategy definition is still open (project spec §3), and inventing a
 * placeholder shape here would get copied into strategy-engine and the
 * backtester before the real rules land.
 *
 * When the definition arrives, replace `rules: Record<string, unknown>` with a
 * real sub-schema and add a migration that stamps existing docs with rulesVersion.
 */
@Schema({ collection: 'strategies', timestamps: true })
export class Strategy {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: '' })
  description: string;

  /** Bumped whenever the rule shape changes, so old signals stay interpretable. */
  @Prop({ default: 0 })
  rulesVersion: number;

  @Prop({ type: Object, default: {} })
  rules: Record<string, unknown>;

  @Prop({ type: [String], enum: Timeframe, default: [] })
  timeframes: Timeframe[];

  /** Broker symbols this runs against. Empty means "every symbol on the account". */
  @Prop({ type: [String], default: [] })
  symbols: string[];

  @Prop({ default: false })
  enabled: boolean;
}

export const StrategySchema = SchemaFactory.createForClass(Strategy);
StrategySchema.index({ userId: 1, name: 1 }, { unique: true });
