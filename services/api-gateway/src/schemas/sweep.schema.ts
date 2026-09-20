import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * One run of a sweep: which setting it moves, where to, and the backtest that
 * answered it.
 *
 * `runId` may point at a backtest an earlier sweep already produced — the
 * fingerprint makes identical questions share one answer. Keeping the axis
 * here rather than on the backtest is what allows that: the same result is the
 * base configuration of nine different axes, and it cannot carry nine labels.
 */
@Schema({ _id: false })
export class SweepCellDoc {
  @Prop({ required: true }) axis: string;
  @Prop({ type: Object, default: null }) value: unknown;
  @Prop({ type: Types.ObjectId, ref: 'Backtest', default: null })
  runId: Types.ObjectId | null;
}
export const SweepCellSchema = SchemaFactory.createForClass(SweepCellDoc);

/**
 * A sweep of one strategy: every setting moved across its declared range, one
 * at a time, over the same pairs and window.
 *
 * See `docs/specs/2026-09-20-cells-sweeps-and-filters-design.md`.
 */
@Schema({ collection: 'sweeps', timestamps: true })
export class Sweep {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true }) label: string;
  @Prop({ required: true }) detector: string;

  /** Frozen with the sweep: results from another version are not comparable. */
  @Prop({ default: null }) detectorVersion: number | null;

  /** The settings every cell varies around. */
  @Prop({ type: Object, default: {} }) baseParams: Record<string, unknown>;

  @Prop({ type: [String], default: [] }) symbols: string[];
  @Prop({ type: [String], default: [] }) timeframes: string[];
  @Prop({ type: Date, required: true }) fromDate: Date;
  @Prop({ type: Date, required: true }) toDate: Date;

  /** The simulation settings, identical across every cell so they compare. */
  @Prop({ type: Object, default: {} }) sim: Record<string, unknown>;

  @Prop({ type: [SweepCellSchema], default: [] }) cells: SweepCellDoc[];

  /** How many cells were already answered when the sweep was launched. */
  @Prop({ default: 0 }) reusedCount: number;

  @Prop({ type: Boolean, default: false, index: true }) archived: boolean;

  /** Set when the user stops it; queued cells are then left alone. */
  @Prop({ type: Boolean, default: false }) cancelled: boolean;
}

export type SweepDocument = Sweep & Document;
export const SweepSchema = SchemaFactory.createForClass(Sweep);
SweepSchema.index({ userId: 1, createdAt: -1 });
