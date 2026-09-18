import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SystemLogDocument = HydratedDocument<SystemLog>;

export enum LogLevel {
  DEBUG = 'debug', INFO = 'info', WARN = 'warn', ERROR = 'error',
}

/**
 * Capped collection — this is a rolling tail for the Logs page, not an audit
 * trail. Anything that must survive belongs in its own collection.
 */
@Schema({
  collection: 'system_logs',
  timestamps: { createdAt: true, updatedAt: false },
  capped: { size: 64 * 1024 * 1024, max: 200_000 },
})
export class SystemLog {
  @Prop({ required: true, index: true })
  service: string;

  @Prop({ type: String, enum: LogLevel, default: LogLevel.INFO, index: true })
  level: LogLevel;

  @Prop({ required: true })
  message: string;

  @Prop({ type: Object, default: {} })
  context: Record<string, unknown>;
}

export const SystemLogSchema = SchemaFactory.createForClass(SystemLog);
