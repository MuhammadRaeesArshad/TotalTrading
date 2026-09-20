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
import { fingerprint, withSimDefaults } from './backtest.fingerprint';
import { StartBacktestDto, StartSweepDto } from './dto';
import { distinctCount, expandSweep, ParamSpec } from './sweep';
import { describeParams, Dimension, ExploreRow, pipelineFor, toRows, totalsOf } from './explore';
import { Sweep, SweepCellDoc, SweepDocument } from '../schemas/sweep.schema';

const POLL_MS = 1_000;
/**
 * A sweep with the run behind each cell attached. Named because the inferred
 * shape of a populated `lean()` is too large for TypeScript to write down.
 */
export interface SweepView extends Record<string, unknown> {
  cells: (SweepCellDoc & { run: Record<string, unknown> | null })[];
}

/** Write progress only when it has moved this much, so a long run is not a write per second. */
const PROGRESS_STEP_PCT = 2;
const INSERT_CHUNK = 1_000;
/** A sweep queues at most this many runs; past it, narrow the settings. */
const MAX_SWEEP_CELLS = 400;

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
  /** Sweeps currently choosing their next cell — keeps the queue single-file. */
  private readonly pumping = new Set<string>();
  /** run id → the sweep waiting on it, so finishing one starts the next. */
  private readonly sweepOf = new Map<string, string>();

  constructor(
    @InjectModel(Backtest.name) private readonly backtests: Model<BacktestDocument>,
    @InjectModel(Trade.name) private readonly trades: Model<TradeDocument>,
    @InjectModel(Sweep.name) private readonly sweeps: Model<SweepDocument>,
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

    await this.pruneOrphanedSweeps();
  }

  /**
   * Drops sweeps whose runs are all gone.
   *
   * Deleting a run detaches it from its sweep, but runs deleted before that
   * existed left sweeps pointing at nothing — shells that still offered
   * themselves in every picker and answered with zero trades. This clears them
   * once, and costs one query per boot afterwards.
   */
  private async pruneOrphanedSweeps() {
    const sweeps = await this.sweeps.find({}).select({ _id: 1, cells: 1 }).lean();
    if (!sweeps.length) return;

    const referenced = sweeps.flatMap((s) => s.cells.map((c) => c.runId).filter(Boolean));
    const alive = new Set(
      (await this.backtests.find({ _id: { $in: referenced } }).select({ _id: 1 }).lean())
        .map((r) => String(r._id)),
    );

    const dead = sweeps
      .filter((s) => !s.cells.some((c) => c.runId && alive.has(String(c.runId))))
      .map((s) => s._id);
    if (!dead.length) return;

    await this.sweeps.deleteMany({ _id: { $in: dead } });
    this.log.log(`Removed ${dead.length} sweep(s) whose runs no longer exist.`);
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

    // A backtest is a pure function of its inputs. If this exact question has
    // already been answered, hand back the answer rather than spending minutes
    // recomputing it — the whole point of the fingerprint.
    const key = await this.fingerprintOf(dto, symbols, higher);
    if (key) {
      const hit = await this.backtests
        .findOne({
          userId: new Types.ObjectId(userId),
          fingerprint: key,
          status: BacktestStatus.COMPLETED,
        })
        .sort({ createdAt: -1 })
        .lean();
      if (hit) {
        this.log.log(`Reusing ${String(hit._id)} for ${key} — identical request.`);
        return hit;
      }
    }

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
      capital: sim.capital ?? 'shared',
      sizing: sim.sizing ?? 'fixed',
      fingerprint: key,
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
          capital: sim.capital,
          sizing: sim.sizing,
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

  /** `archived` picks which shelf: the working list, or the one put aside. */
  /**
   * The cache key for a request, or null when it cannot be computed — the
   * engine being unreachable, or a detector it does not know. A missing key
   * only costs a cache miss, so it never blocks a run.
   */
  private async fingerprintOf(
    dto: StartBacktestDto,
    symbols: string[],
    higher: string[],
  ): Promise<string | null> {
    try {
      const [health, detectors] = await Promise.all([
        this.engine.health(),
        this.engine.detectors(),
      ]);
      const version = detectors.versions?.[dto.detector];
      // An unknown detector means the engine is about to refuse the run
      // anyway; hashing it would only store a key for a result never produced.
      if (version === undefined || !health.engine_version) return null;

      return fingerprint({
        detector: dto.detector,
        detectorVersion: version,
        params: (dto.params ?? {}) as Record<string, unknown>,
        symbols,
        timeframe: dto.timeframe,
        higherTimeframes: higher,
        fromTs: dto.fromTs,
        toTs: dto.toTs,
        sim: withSimDefaults(dto.sim),
        engineVersion: health.engine_version,
      });
    } catch (err) {
      this.log.warn(`Could not fingerprint the request: ${String(err)}. Running it.`);
      return null;
    }
  }

  /**
   * Explores a whole strategy: every setting moved across its own declared
   * range, one at a time, over the same pairs and window.
   *
   * The cells are created up front so the sweep's shape is known immediately,
   * then run one at a time. One at a time matters — the engine saturates every
   * core it has with rayon, so launching ten at once would not finish sooner,
   * it would just contend for the same threads (see `CLAUDE.md`, Parallelism).
   */
  async startSweep(userId: string, dto: StartSweepDto): Promise<SweepView> {
    if (dto.fromTs >= dto.toTs) {
      throw new BadRequestException('The start date must come before the end date.');
    }

    const { strategies } = await this.engine.detectors();
    const strategy = (strategies as { name: string; version: number; params: ParamSpec[] }[])
      .find((s) => s.name === dto.detector);
    if (!strategy) {
      throw new BadRequestException(`The engine does not know a strategy called ${dto.detector}.`);
    }

    const cells = expandSweep(strategy.params ?? [], dto.params ?? {}, {
      steps: dto.steps,
      only: dto.only,
    });
    if (!cells.length) {
      throw new BadRequestException(
        `${dto.detector} declares no settings with a range to sweep.`,
      );
    }
    if (distinctCount(cells) > MAX_SWEEP_CELLS) {
      throw new BadRequestException(
        `That is ${distinctCount(cells)} runs. Narrow the settings or lower the step count; ` +
          `${MAX_SWEEP_CELLS} is the most this will queue at once.`,
      );
    }

    const sweep = await this.sweeps.create({
      userId: new Types.ObjectId(userId),
      label: `${dto.detector} · sensitivity`,
      detector: dto.detector,
      detectorVersion: strategy.version,
      baseParams: dto.params ?? {},
      symbols: [...new Set(dto.symbols)],
      timeframes: [dto.timeframe, ...(dto.higherTimeframes ?? [])],
      fromDate: new Date(dto.fromTs * 1_000),
      toDate: new Date(dto.toTs * 1_000),
      sim: (dto.sim ?? {}) as Record<string, unknown>,
      cells: cells.map((c) => ({ axis: c.axis, value: c.value, runId: null })),
    });

    // Kick the queue; it returns immediately and works in the background.
    void this.pump(String(sweep._id));
    return this.getSweep(userId, String(sweep._id));
  }

  async listSweeps(userId: string, archived = false): Promise<Record<string, unknown>[]> {
    return this.sweeps
      .find({ userId: new Types.ObjectId(userId), archived: archived ? true : { $ne: true } })
      .sort({ createdAt: -1 })
      .lean();
  }

  /** The sweep plus the run behind each cell, which is what a chart needs. */
  async getSweep(userId: string, id: string): Promise<SweepView> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('No sweep with that id.');
    const sweep = await this.sweeps
      .findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
      .lean();
    if (!sweep) throw new NotFoundException('No sweep with that id.');

    const ids = sweep.cells.map((c) => c.runId).filter(Boolean) as Types.ObjectId[];
    const runs = await this.backtests
      .find({ _id: { $in: ids } })
      .select({ equityCurve: 0, rulesSnapshot: 0 })
      .lean();
    const byId = new Map(runs.map((r) => [String(r._id), r]));

    return {
      ...sweep,
      cells: sweep.cells.map((c) => ({
        ...c,
        run: c.runId ? byId.get(String(c.runId)) ?? null : null,
      })),
    };
  }

  async cancelSweep(userId: string, id: string): Promise<Record<string, unknown>> {
    const sweep = await this.sweeps
      .findOneAndUpdate(
        { _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) },
        { cancelled: true },
        { new: true },
      )
      .lean();
    if (!sweep) throw new NotFoundException('No sweep with that id.');
    return sweep;
  }

  /**
   * Starts the next unanswered cell of a sweep, if nothing of it is already
   * running. Called on launch and again whenever a run finishes, so the queue
   * advances itself without a scheduler.
   */
  private async pump(sweepId: string) {
    if (this.pumping.has(sweepId)) return;
    this.pumping.add(sweepId);
    try {
      const sweep = await this.sweeps.findById(sweepId).lean();
      if (!sweep || sweep.cancelled) return;

      const next = sweep.cells.findIndex((c) => !c.runId);
      if (next < 0) return; // every cell has an answer

      const cell = sweep.cells[next];
      const run = await this.start(String(sweep.userId), {
        detector: sweep.detector,
        params: { ...sweep.baseParams, [cell.axis]: cell.value },
        symbols: sweep.symbols,
        timeframe: sweep.timeframes[0],
        higherTimeframes: sweep.timeframes.slice(1),
        fromTs: Math.floor(sweep.fromDate.getTime() / 1_000),
        toTs: Math.floor(sweep.toDate.getTime() / 1_000),
        sim: sweep.sim,
      } as StartBacktestDto);

      const reused = run.status === BacktestStatus.COMPLETED;
      await this.sweeps.updateOne(
        { _id: sweep._id },
        {
          $set: { [`cells.${next}.runId`]: run._id },
          ...(reused ? { $inc: { reusedCount: 1 } } : {}),
        },
      );
      this.sweepOf.set(String(run._id), sweepId);

      // A reused answer finished the moment it was asked, so keep going
      // rather than waiting for a completion that already happened.
      if (reused) {
        this.pumping.delete(sweepId);
        await this.pump(sweepId);
      }
    } catch (err) {
      this.log.error(`Sweep ${sweepId} stalled: ${String(err)}`);
    } finally {
      this.pumping.delete(sweepId);
    }
  }

  list(userId: string, archived = false) {
    return this.backtests
      .find({ userId: new Types.ObjectId(userId), archived: archived ? true : { $ne: true } })
      .select({ equityCurve: 0, rulesSnapshot: 0 })
      .sort({ createdAt: -1 })
      .lean();
  }

  /** Moves a run between the two lists. Nothing is lost either way. */
  async setArchived(userId: string, id: string, archived: boolean) {
    const run = await this.backtests
      .findOneAndUpdate(this.owned(userId, id), { archived }, { new: true })
      .lean();
    if (!run) throw new NotFoundException('No backtest with that id.');
    return run;
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

  /**
   * Per-pair totals for one run.
   *
   * Grouped in Mongo rather than by sending thousands of trades to the browser
   * — the list page shows this for several runs at once, and the answer is a
   * few dozen rows however many trades produced it.
   */
  async byPair(userId: string, id: string) {
    await this.get(userId, id);
    const rows = await this.trades.aggregate<{
      _id: string; n: number; wins: number; sumR: number; net: number;
    }>([
      { $match: { backtestId: new Types.ObjectId(id), source: TradeSource.BACKTEST } },
      {
        $group: {
          _id: '$symbol',
          n: { $sum: 1 },
          // Same rule as the engine: a trade that nets zero or better is a win.
          wins: { $sum: { $cond: [{ $gte: ['$netProfit', 0] }, 1, 0] } },
          sumR: { $sum: '$rMultiple' },
          net: { $sum: '$netProfit' },
        },
      },
      { $sort: { sumR: -1 } },
    ]);

    return rows.map((r) => ({
      symbol: r._id,
      n: r.n,
      wins: r.wins,
      winRate: r.n ? r.wins / r.n : 0,
      sumR: r.sumR,
      net: r.net,
    }));
  }

  /**
   * Slices trades across many runs at once.
   *
   * `setting` grouping comes back keyed by run id, which means nothing on its
   * own — the sweep knows which setting each run was moving, so the label is
   * put on here rather than asking the browser to join it.
   */
  async explore(userId: string, body: {
    runIds?: string[];
    sweepId?: string;
    by: Dimension[];
    minTrades?: number;
    pairs?: string[];
    sessions?: string[];
    side?: 'long' | 'short';
    result?: 'win' | 'loss';
    from?: string;
    to?: string;
  }) {
    const uid = new Types.ObjectId(userId);
    let runIds = body.runIds ?? [];
    let labels = new Map<string, string>();

    if (body.sweepId) {
      const sweep = await this.sweeps
        .findOne({ _id: new Types.ObjectId(body.sweepId), userId })
        .lean();
      if (!sweep) throw new NotFoundException('No sweep with that id.');
      runIds = sweep.cells.filter((c) => c.runId).map((c) => String(c.runId));
    }

    // Only the caller's own runs, whatever they asked for.
    const owned = await this.backtests
      .find({ _id: { $in: runIds.map((id) => new Types.ObjectId(id)) }, userId: uid })
      .select({ _id: 1, detector: 1, detectorVersion: 1, rulesSnapshot: 1 })
      .lean();
    const allowed = owned.map((r) => String(r._id));
    if (!allowed.length) {
      return { rows: [] as ExploreRow[], totals: totalsOf([]), runs: 0, by: body.by };
    }

    const query = {
      runIds: allowed,
      by: body.by,
      minTrades: body.minTrades ?? 1,
      pairs: body.pairs,
      sessions: body.sessions,
      side: body.side,
      result: body.result,
      from: body.from,
      to: body.to,
    };
    const raw = await this.trades.aggregate(pipelineFor(query) as never[]);
    const rows = toRows(raw as never[], body.by);

    // A run id is not a finding; say which setting it was. Labels come from
    // whichever sweep produced the run — not only the one being explored,
    // since "every backtest" is a perfectly good scope to ask this of.
    const settingAt = body.by.indexOf('setting');
    if (settingAt >= 0) {
      const ids = owned.map((r) => r._id);
      for (const sw of await this.sweeps.find({ userId: uid, 'cells.runId': { $in: ids } }).lean()) {
        for (const c of sw.cells) {
          if (c.runId && !labels.has(String(c.runId))) {
            labels.set(String(c.runId), `${c.axis} = ${String(c.value)}`);
          }
        }
      }

      // Anything not from a sweep is described by what it changed. The engine
      // holds the defaults; if it cannot be reached the detector name is all
      // there is, which is no worse than before and never blocks the query.
      let defaults: Record<string, Record<string, unknown>> = {};
      if (owned.some((r) => !labels.has(String(r._id)))) {
        try {
          const { strategies } = await this.engine.detectors();
          for (const st of strategies as { name: string; params: { key: string; default: unknown }[] }[]) {
            defaults[st.name] = Object.fromEntries(
              (st.params ?? []).map((p) => [p.key, p.default]),
            );
          }
        } catch {
          defaults = {};
        }
      }

      for (const row of rows) {
        const id = row.keys[settingAt];
        const run = owned.find((r) => String(r._id) === id);
        row.keys[settingAt] = labels.get(id)
          ?? (run
            ? describeParams(
              run.rulesSnapshot as Record<string, unknown>,
              defaults[run.detector] ?? {},
              run.detector,
            )
            : id);
      }
    }

    return { rows, totals: totalsOf(rows), runs: allowed.length, by: body.by };
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

  /**
   * Deletes a run, its trades, and its place in any sweep.
   *
   * A sweep holds only the plan — which setting each cell moved and where to.
   * Its answers are the runs. Leaving the sweep behind when they go produces a
   * shell that still offers itself in every picker and returns nothing, which
   * is exactly what happened when the user cleared their backtests.
   */
  async remove(userId: string, id: string) {
    const run = await this.get(userId, id);
    this.stop(String(run._id));
    await this.trades.deleteMany({ backtestId: run._id, source: TradeSource.BACKTEST });
    await this.backtests.deleteOne({ _id: run._id });

    // Detach it from any sweep, so a cell that lost its answer is unanswered
    // rather than pointing at nothing — and can be re-run.
    await this.sweeps.updateMany(
      { userId: new Types.ObjectId(userId), 'cells.runId': run._id },
      { $set: { 'cells.$[c].runId': null } },
      { arrayFilters: [{ 'c.runId': run._id }] },
    );

    // A sweep with no answers left is a plan and nothing else. Deleting the
    // last run of one is a deliberate act, and keeping the husk helps nobody.
    const emptied = await this.sweeps.deleteMany({
      userId: new Types.ObjectId(userId),
      cells: { $not: { $elemMatch: { runId: { $ne: null } } } },
    });
    if (emptied.deletedCount) {
      this.log.log(`Removed ${emptied.deletedCount} sweep(s) left with no runs.`);
    }

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
    this.advanceSweep(id);
  }

  private async fail(id: string, reason: string) {
    this.stop(id);
    await this.backtests.updateOne(
      { _id: id },
      { status: BacktestStatus.FAILED, error: reason, finishedAt: new Date() },
    );
    // A failed cell still has an answer of a sort, and stopping the whole
    // sweep because one setting was refused would waste the rest.
    this.advanceSweep(String(id));
  }

  /** A run this sweep was waiting on has settled — start the next cell. */
  private advanceSweep(runId: string) {
    const sweepId = this.sweepOf.get(runId);
    if (!sweepId) return;
    this.sweepOf.delete(runId);
    void this.pump(sweepId);
  }

  private owned(userId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('No backtest with that id.');
    return { _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) };
  }
}
