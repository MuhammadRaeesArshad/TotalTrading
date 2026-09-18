import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AiReportDocument = HydratedDocument<AiReport>;

export enum AiReportSubject {
  BACKTEST = 'backtest',
  SCAN = 'scan',
  JOURNAL = 'journal',
  NEWS = 'news',
}

export enum AiReportStatus {
  PENDING = 'pending',
  READY = 'ready',
  FAILED = 'failed',
}

/**
 * Commentary written by the local model. Written only by ai-analysis.
 * `inputPayload` is the structured data the model was given — never raw OHLC
 * (spec §4) — kept so a report can be re-read against what produced it.
 */
@Schema({ collection: 'ai_reports', timestamps: true })
export class AiReport {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: AiReportSubject, required: true, index: true })
  subject: AiReportSubject;

  /** Points at a Backtest, Strategy, or similar, depending on `subject`. */
  @Prop({ type: Types.ObjectId, default: null, index: true })
  subjectId: Types.ObjectId | null;

  @Prop({ type: String, enum: AiReportStatus, default: AiReportStatus.PENDING })
  status: AiReportStatus;

  @Prop({ default: null }) model: string | null;
  @Prop({ default: null }) promptVersion: string | null;
  @Prop({ default: null }) tokensUsed: number | null;
  @Prop({ default: null }) latencyMs: number | null;

  @Prop({ type: Object, default: {} })
  inputPayload: Record<string, unknown>;

  @Prop({ default: '' })
  body: string;

  @Prop({ type: String, default: null })
  error: string | null;
}

export const AiReportSchema = SchemaFactory.createForClass(AiReport);
AiReportSchema.index({ userId: 1, createdAt: -1 });
