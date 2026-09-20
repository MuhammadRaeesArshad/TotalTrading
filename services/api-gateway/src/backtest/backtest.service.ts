import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Backtest, BacktestDocument, BacktestStatus, Trade, TradeDocument, TradeSource,
} from '../schemas';
import { BacktestClient, EngineJob } from './backtest.client';
import { mapEquity, mapMetrics, mapSkipped, mapTrade, tradeWindow } from './backtest.mapping';
import { StartBacktestDto } from './dto';

const POLL_MS = 1_000;
/** Write progress only when it has moved this much, so a long run is not a write per second. */
const PROGRESS_STEP_PCT = 2;
const INSERT_CHUNK = 1_000;

/**
 * Owns a backtest's life from request to stored result.
 *
 * The engine computes and forgets — it holds results in memory and has no
 * database (rule 3). So this service starts the engine job, polls it, and
 * persists the run and every trade the moment it completes. If the gateway
 * restarts mid-run it picks unfinished runs back up on boot; if the engine
 * restarted too, the run is marked failed with a reason rather than left
 * spinning.
 */
@Injectable()
export class BacktestService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BacktestService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectModel(Backtest.name) private readonly backtests: Model<BacktestDocument>,
    @InjectModel(Trade.name) private readonly trades: Model<TradeDocument>,
    private readonly engine: BacktestClient,
  ) {}

  async onModuleInit() {
    const unfinished = await this.backtests
      .find({ status: { $in: [BacktestStatus.QUEUED, BacktestStatus.RUNNING] } })
      .select({ _id: 1, engineRunId: 1 })
      .lean();
    for (const run of unfinished) {
      if (run.engineRunId) {
        this.track(String(run._id), run.engineRunId);
      } else {
        await this.fail(String(run._id), 'The gateway restarted before the engine accepted this run.');
      }
    }
    if (unfinished.length) this.log.log(`Resumed ${unfinished.length} unfinished run(s).`);
  }

  onModuleDestroy() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  async start(userId: string, dto: StartBacktestDto) {
    if (dto.fromTs >= dto.toTs) {
      throw new BadRequestException('The start date must come before the end date.');
    }
    const symbols = [...new Set(dto.symbols)];
    const higher = [...new Set(dto.higherTimeframes ?? [])].filter((t) => t !== dto.timeframe);
    const sim = dto.sim ?? {};

    const doc = await this.backtests.create({
      userId: new Types.ObjectId(userId),
      strategyId: null,
      detector: dto.detector,
      symbols,
      timeframes: [dto.timeframe, ...higher],
      fromDate: new Date(dto.fromTs * 1_000),
      toDate: new Date(dto.toTs * 1_000),
      // Frozen with the run: which settings produced this result (rule 6).
      rulesSnapshot: dto.params ?? {},
      initialBalance: sim.initialBalance ?? 10_000,
      riskPercentPerTrade: sim.riskPercent ?? 1,
      intrabarPolicy: sim.intrabar ?? 'pessimistic',
      status: BacktestStatus.QUEUED,
    });

    let engineRunId: string;
    try {
      const started = await this.engine.startRun({
        detector: dto.detector,
        params: dto.params,
        symbols,
        timeframe: dto.timeframe,
        higher_timeframes: higher,
        from_ts: dto.fromTs,
        to_ts: dto.toTs,
        sim: {
          initial_balance: sim.initialBalance,
          risk_percent: sim.riskPercent,
          max_open_per_symbol: sim.maxOpenPerSymbol,
          intrabar: sim.intrabar,
          commission_per_lot: sim.commissionPerLot,
          extra_spread_points: sim.extraSpreadPoints,
          slippage_points: sim.slippagePoints,
        },
      });
      engineRunId = started.id;
    } catch (err) {
      // The engine refused it — a missing symbol, an unknown detector. Keep the
      // record so the attempt is visible, marked with the engine's reason.
      await this.fail(String(doc._id), err instanceof Error ? err.message : String(err));
      throw err;
    }

    await this.backtests.updateOne(
      { _id: doc._id },
      { engineRunId, status: BacktestStatus.RUNNING, startedAt: new Date() },
    );
    this.track(String(doc._id), engineRunId);
    return this.get(userId, String(doc._id));
  }

  list(userId: string) {
    return this.backtests
      .find({ userId: new Types.ObjectId(userId) })
      .select({ equityCurve: 0, rulesSnapshot: 0 })
      .sort({ createdAt: -1 })
      .lean();
  }

  async get(userId: string, id: string) {
    const run = await this.backtests.findOne(this.owned(userId, id)).lean();
    if (!run) throw new NotFoundException('No backtest with that id.');
    return run;
  }

  async listTrades(userId: string, id: string) {
    await this.get(userId, id);
    return this.trades
      .find({ backtestId: new Types.ObjectId(id), source: TradeSource.BACKTEST })
      .sort({ entryTime: 1 })
      .lean({ flattenMaps: true });
  }

  /** Bars around one trade, from the engine's cache, for its chart. */
  async tradeBars(userId: string, id: string, tradeId: string) {
    const run = await this.get(userId, id);
    if (!Types.ObjectId.isValid(tradeId)) throw new NotFoundException('No trade with that id.');
    const trade = await this.trades
      .findOne({ _id: new Types.ObjectId(tradeId), backtestId: run._id })
      .lean();
    if (!trade) throw new NotFoundException('No trade with that id in this backtest.');

    const timeframe = run.timeframes[0];
    const { fromTs, toTs } = tradeWindow(trade.entryTime, trade.exitTime, timeframe);
    return this.engine.bars(trade.symbol, timeframe, fromTs, toTs);
  }

  async remove(userId: string, id: string) {
    const run = await this.get(userId, id);
    this.stop(String(run._id));
    await this.trades.deleteMany({ backtestId: run._id, source: TradeSource.BACKTEST });
    await this.backtests.deleteOne({ _id: run._id });
    return { deleted: id };
  }

  // ------------------------------------------------------------------ polling

  private track(id: string, engineRunId: string) {
    if (this.timers.has(id)) return;
    let lastPct = -Infinity;

    const tick = async () => {
      this.timers.delete(id);
      let job: EngineJob;
      try {
        job = await this.engine.runProgress(engineRunId);
      } catch (err) {
        const status = (err as { status?: number })?.status ?? (err as { getStatus?: () => number })?.getStatus?.();
        if (status === 404) {
          await this.fail(id, 'The engine restarted and no longer has this run. Start it again.');
          return;
        }
        // Engine briefly unreachable: keep trying rather than failing the run.
        this.schedule(id, tick, POLL_MS * 5);
        return;
      }

      switch (job.status) {
        case 'queued':
        case 'running':
          if (job.progress_pct - lastPct >= PROGRESS_STEP_PCT) {
            lastPct = job.progress_pct;
            await this.backtests.updateOne({ _id: id }, { progressPct: Math.round(job.progress_pct) });
          }
          this.schedule(id, tick, POLL_MS);
          return;
        case 'completed':
          await this.persist(id, engineRunId);
          return;
        case 'cancelled':
          await this.backtests.updateOne(
            { _id: id },
            { status: BacktestStatus.CANCELLED, finishedAt: new Date() },
          );
          return;
        default:
          await this.fail(id, job.error ?? 'The engine reported a failure without a reason.');
      }
    };

    this.schedule(id, tick, POLL_MS);
  }

  private schedule(id: string, fn: () => Promise<void>, ms: number) {
    const t = setTimeout(() => {
      fn().catch((err) => this.log.error(`Polling run ${id} failed: ${err instanceof Error ? err.message : err}`));
    }, ms);
    this.timers.set(id, t);
  }

  private stop(id: string) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  /**
   * Stores a finished run. Trades go in first and the run flips to completed
   * last, so a crash in between leaves a run that is still "running" and gets
   * retried on boot — and the retry clears any partial insert before writing.
   */
  private async persist(id: string, engineRunId: string) {
    const job = await this.engine.runResult(engineRunId);
    const result = job.result;
    if (!result) {
      await this.fail(id, 'The engine finished but returned no result.');
      return;
    }

    const run = await this.backtests.findById(id).lean();
    if (!run) return; // deleted while running

    await this.trades.deleteMany({ backtestId: run._id, source: TradeSource.BACKTEST });
    const ids = { userId: run.userId, backtestId: run._id, strategyId: run.strategyId ?? null };
    const docs = result.trades.map((t) => mapTrade(t, ids));
    for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
      await this.trades.insertMany(docs.slice(i, i + INSERT_CHUNK), { ordered: false });
    }

    await this.backtests.updateOne(
      { _id: run._id },
      {
        status: BacktestStatus.COMPLETED,
        progressPct: 100,
        detector: result.detector,
        detectorVersion: result.detector_version,
        engineVersion: result.engine_version,
        metrics: mapMetrics(result.metrics),
        equityCurve: mapEquity(result.equity_curve),
        signalsGenerated: result.signals_generated,
        skipped: mapSkipped(result.skipped),
        barsProcessed: result.bars_processed,
        elapsedMs: result.elapsed_ms,
        finishedAt: new Date(),
        error: null,
      },
    );
    this.log.log(`Run ${id} stored: ${docs.length} trades.`);
  }

  private async fail(id: string, reason: string) {
    this.stop(id);
    await this.backtests.updateOne(
      { _id: id },
      { status: BacktestStatus.FAILED, error: reason, finishedAt: new Date() },
    );
  }

  private owned(userId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('No backtest with that id.');
    return { _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) };
  }
}
