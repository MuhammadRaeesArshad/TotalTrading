import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type Mt5AccountDocument = HydratedDocument<Mt5Account>;

export enum Mt5AccountMode {
  DEMO = 'demo',
  LIVE = 'live',
}

export enum Mt5ConnectionState {
  NEVER_CONNECTED = 'never_connected',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
}

/** What this account is permitted to do. Execution stays off until backtest/live parity is proven. */
@Schema({ _id: false })
export class Mt5AccountPermissions {
  @Prop({ default: true })
  readMarketData: boolean;

  @Prop({ default: true })
  readPositions: boolean;

  /** Hard-off for v1. Flipping this on is a deliberate, separate decision. */
  @Prop({ default: false })
  placeOrders: boolean;
}
export const Mt5AccountPermissionsSchema =
  SchemaFactory.createForClass(Mt5AccountPermissions);

/** Snapshot of the last successful /account read from mt5-connector. */
@Schema({ _id: false })
export class Mt5AccountSnapshot {
  @Prop() balance: number;
  @Prop() equity: number;
  @Prop() margin: number;
  @Prop() marginFree: number;
  @Prop() marginLevel: number;
  @Prop() profit: number;
  @Prop() currency: string;
  @Prop() leverage: number;
  @Prop() tradeAllowed: boolean;
  @Prop({ type: Date }) capturedAt: Date;
}
export const Mt5AccountSnapshotSchema =
  SchemaFactory.createForClass(Mt5AccountSnapshot);

@Schema({ collection: 'mt5_accounts', timestamps: true })
export class Mt5Account {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  /** Human label, e.g. "IC Markets demo". */
  @Prop({ required: true, trim: true })
  label: string;

  /** MT5 login number. Stored as a string — some brokers issue leading zeros. */
  @Prop({ required: true, trim: true })
  login: string;

  /** MT5 server name exactly as the terminal spells it, e.g. "ICMarketsSC-Demo". */
  @Prop({ required: true, trim: true })
  server: string;

  /**
   * AES-256-GCM ciphertext of the investor/trading password.
   * Format: v1:<iv-b64>:<tag-b64>:<ciphertext-b64>. Never selected by default.
   * See common/crypto.service.ts — the key comes from MT5_CRED_KEY, not the DB.
   */
  @Prop({ required: true, select: false })
  passwordCiphertext: string;

  @Prop({ type: String, enum: Mt5AccountMode, default: Mt5AccountMode.DEMO })
  mode: Mt5AccountMode;

  @Prop({ trim: true, default: null })
  broker: string | null;

  @Prop({
    type: String,
    enum: Mt5ConnectionState,
    default: Mt5ConnectionState.NEVER_CONNECTED,
  })
  connectionState: Mt5ConnectionState;

  @Prop({ type: String, default: null })
  lastError: string | null;

  @Prop({ type: Date, default: null })
  lastConnectedAt: Date | null;

  @Prop({ type: Mt5AccountSnapshotSchema, default: null })
  snapshot: Mt5AccountSnapshot | null;

  @Prop({ type: Mt5AccountPermissionsSchema, default: () => ({}) })
  permissions: Mt5AccountPermissions;

  /** Symbols the broker actually offers, resolved on connect. Source of truth for the pair list. */
  @Prop({ type: [String], default: [] })
  availableSymbols: string[];

  @Prop({ default: true })
  isActive: boolean;
}

export const Mt5AccountSchema = SchemaFactory.createForClass(Mt5Account);

// One MT5 login per server per user — re-adding the same account should update, not duplicate.
Mt5AccountSchema.index({ userId: 1, login: 1, server: 1 }, { unique: true });

Mt5AccountSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete (ret as unknown as Record<string, unknown>).passwordCiphertext;
    delete (ret as unknown as Record<string, unknown>).__v;
    return ret;
  },
});
