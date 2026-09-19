//! Orchestration.
//!
//! # How the work is split
//!
//! Detection is embarrassingly parallel: each (symbol, timeframe) reads its
//! own mapped file and produces its own signals, touching nothing shared.
//! Rayon spreads those across cores.
//!
//! Portfolio simulation is not. Position size depends on current equity, and
//! equity depends on every trade that closed before it, across every pair. Run
//! that in parallel and the result depends on thread scheduling — a backtest
//! that returns a different number each time it runs.
//!
//! So: detect in parallel, merge by time, simulate in one pass. The expensive
//! half scales with cores and the sequential half is a linear walk over a
//! sorted vector.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::engine::align::Alignment;
use crate::engine::detector::{DetectorFactory, Signal, SignalSink};
use crate::engine::metrics::{EquityPoint, Metrics, MetricsAccumulator};
use crate::engine::sim::{
    close_position, resolve_exit, BarSlice, OpenPosition, SimConfig, Trade,
};
use crate::engine::window::{BarCtx, HigherTimeframe};
use crate::error::{CoreError, Result};
use crate::store::Bars;
use crate::timeframe::Timeframe;

/// One symbol on one timeframe, with whatever higher timeframes its rules read.
pub struct ScanTask {
    pub bars: Arc<Bars>,
    pub higher: Vec<Arc<Bars>>,
    /// Per-symbol simulation parameters — point size and point value differ
    /// between a 5-digit major and a 3-digit JPY cross, and getting that wrong
    /// misprices every position by a factor of a hundred.
    pub sim: SimConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRequest {
    pub detector: String,
    pub from_ts: i64,
    pub to_ts: i64,
    pub sim: SimConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub metrics: Metrics,
    pub equity_curve: Vec<EquityPoint>,
    pub trades: Vec<Trade>,
    pub bars_processed: usize,
    pub signals_generated: usize,
    pub elapsed_ms: u128,
    pub engine_version: String,
}

/// Progress, shared with whatever is reporting it. Atomics rather than a lock:
/// workers touch this on every chunk and a mutex here would serialise them.
#[derive(Debug, Default)]
pub struct Progress {
    pub bars_done: AtomicUsize,
    pub bars_total: AtomicUsize,
    pub tasks_done: AtomicUsize,
    pub tasks_total: AtomicUsize,
    /// Set to ask an in-flight run to stop. Checked at chunk boundaries, so a
    /// cancel lands within a few thousand bars rather than instantly — cheap
    /// enough to poll, responsive enough to feel immediate on a long run.
    cancelled: AtomicBool,
}

impl Progress {
    /// Ask a running scan to stop. Idempotent.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    #[inline]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub fn percent(&self) -> f64 {
        let total = self.bars_total.load(Ordering::Relaxed);
        if total == 0 {
            return 0.0;
        }
        let done = self.bars_done.load(Ordering::Relaxed);
        (done as f64 / total as f64 * 100.0).min(100.0)
    }
}

/// A signal plus the task it came from, so the merged stream stays traceable.
struct TaskSignals {
    symbol: String,
    sim: SimConfig,
    bars: Arc<Bars>,
    signals: Vec<Signal>,
}

pub const ENGINE_VERSION: &str = concat!("rust-", env!("CARGO_PKG_VERSION"));

pub fn run(
    tasks: Vec<ScanTask>,
    request: &RunRequest,
    factory: &dyn DetectorFactory,
    progress: &Progress,
) -> Result<RunResult> {
    let started = std::time::Instant::now();

    if tasks.is_empty() {
        return Err(CoreError::Config(
            "no symbols to scan — check the pair list and that bars have been imported".into(),
        ));
    }

    progress.tasks_total.store(tasks.len(), Ordering::Relaxed);
    progress.bars_total.store(
        tasks.iter().map(|t| t.bars.len()).sum(),
        Ordering::Relaxed,
    );

    // ---- Phase 1: detection, in parallel ----------------------------------
    let detected: Vec<TaskSignals> = tasks
        .par_iter()
        .map(|task| scan_one(task, request, factory, progress))
        .collect::<Result<Vec<_>>>()?;

    let bars_processed: usize = tasks.iter().map(|t| t.bars.len()).sum();
    let signals_generated: usize = detected.iter().map(|d| d.signals.len()).sum();

    // ---- Phase 2: merge by time -------------------------------------------
    // Each task's signals are already sorted, so this could be a k-way merge.
    // A single sort is simpler and, at these counts, not the bottleneck — the
    // scan above dominates by orders of magnitude.
    let mut queue: Vec<(usize, usize)> = Vec::with_capacity(signals_generated);
    for (task_index, task) in detected.iter().enumerate() {
        for signal_index in 0..task.signals.len() {
            queue.push((task_index, signal_index));
        }
    }
    queue.sort_unstable_by_key(|&(t, s)| detected[t].signals[s].time);

    // ---- Phase 3: portfolio simulation, sequential ------------------------
    let (metrics, equity_curve, trades) = simulate(&detected, &queue, request);

    Ok(RunResult {
        metrics,
        equity_curve,
        trades,
        bars_processed,
        signals_generated,
        elapsed_ms: started.elapsed().as_millis(),
        engine_version: ENGINE_VERSION.to_string(),
    })
}

/// Scans one (symbol, timeframe). Runs on a rayon worker; touches nothing shared
/// except the progress counters.
fn scan_one(
    task: &ScanTask,
    request: &RunRequest,
    factory: &dyn DetectorFactory,
    progress: &Progress,
) -> Result<TaskSignals> {
    let bars = &task.bars;
    bars.advise_sequential();

    let mut detector = factory.build();
    detector.reset();

    let alignments: Vec<Alignment> = task
        .higher
        .iter()
        .map(|h| Alignment::build(bars, h))
        .collect();

    let higher: Vec<HigherTimeframe<'_>> = task
        .higher
        .iter()
        .zip(alignments.iter())
        .map(|(h, a)| HigherTimeframe { bars: h.as_ref(), alignment: a })
        .collect();

    let (range_start, range_end) = bars.range(request.from_ts, request.to_ts);

    // Start the scan `warmup` bars early so indicators are warm by the time the
    // requested window begins, but discard anything they emit before it.
    let scan_start = range_start.saturating_sub(detector.warmup());

    let mut sink = SignalSink::with_capacity(1_024);
    let mut kept: Vec<Signal> = Vec::new();

    // Progress is reported per chunk, not per bar — an atomic add every bar
    // would cost more than the detector.
    const PROGRESS_CHUNK: usize = 8_192;
    let mut since_report = 0usize;

    for i in scan_start..range_end {
        let ctx = BarCtx::new(bars, i, &higher);
        detector.on_bar(&ctx, &mut sink);

        if !sink.is_empty() {
            for signal in sink.drain() {
                if i >= range_start && signal.is_coherent() {
                    kept.push(signal);
                }
            }
        }

        since_report += 1;
        if since_report >= PROGRESS_CHUNK {
            progress.bars_done.fetch_add(since_report, Ordering::Relaxed);
            since_report = 0;

            if progress.is_cancelled() {
                progress.tasks_done.fetch_add(1, Ordering::Relaxed);
                return Err(CoreError::Cancelled);
            }
        }
    }

    progress.bars_done.fetch_add(since_report, Ordering::Relaxed);
    progress.tasks_done.fetch_add(1, Ordering::Relaxed);

    Ok(TaskSignals {
        symbol: bars.symbol().to_string(),
        sim: task.sim.clone(),
        bars: Arc::clone(bars),
        signals: kept,
    })
}

/// Walks the merged signal stream, opening and closing positions against a
/// single shared equity balance.
fn simulate(
    detected: &[TaskSignals],
    queue: &[(usize, usize)],
    request: &RunRequest,
) -> (Metrics, Vec<EquityPoint>, Vec<Trade>) {
    let mut accumulator =
        MetricsAccumulator::new(request.sim.initial_balance, queue.len());
    let mut trades: Vec<Trade> = Vec::with_capacity(queue.len());

    // One open-position slot per task. `max_open_per_symbol` is enforced here
    // rather than in the detector, so the rules never need to know about
    // portfolio state.
    let mut open: Vec<Vec<OpenPosition>> = detected.iter().map(|_| Vec::new()).collect();

    for &(task_index, signal_index) in queue {
        let task = &detected[task_index];
        let signal = &task.signals[signal_index];
        let config = &task.sim;
        let bars = task.bars.as_ref();

        // Close anything on this symbol that resolved before this signal's bar.
        drain_closed(
            &task.symbol,
            bars,
            config,
            &mut open[task_index],
            signal.bar_index,
            &mut accumulator,
            &mut trades,
        );

        if open[task_index].len() >= config.max_open_per_symbol {
            continue;
        }

        // Entry is on the *next* bar — the signal bar's close is only known
        // once that bar is over.
        let entry_index = signal.bar_index + 1;
        if entry_index >= bars.len() {
            continue;
        }

        let entry_bar = bar_at(bars, entry_index);
        let Some(fill) = config.fill_entry(signal, &entry_bar) else {
            continue;
        };

        // Size off the stop as the detector placed it, but risk is measured
        // from the price actually filled.
        let risk_distance = (fill - signal.stop_loss).abs();
        let Some(volume) = config.position_size(accumulator.equity(), risk_distance) else {
            continue;
        };

        open[task_index].push(OpenPosition {
            direction: signal.direction,
            volume,
            entry_price: fill,
            entry_time: entry_bar.time,
            entry_index,
            stop_loss: signal.stop_loss,
            take_profit: signal.take_profit,
            risk_distance,
            commission: config.commission_per_lot * volume,
            // The entry bar itself is checked for exits. The fill is at its open,
            // and the rest of that bar can still reach the stop or target —
            // skipping it hid stops hit in the first hour of a trade (rule 5).
            scan_cursor: entry_index,
            max_adverse: 0.0,
            max_favorable: 0.0,
            detail: signal.detail.clone(),
        });
    }

    // Walk out whatever is still open at the end of the data.
    for (task_index, task) in detected.iter().enumerate() {
        let bars = task.bars.as_ref();
        drain_closed(
            &task.symbol,
            bars,
            &task.sim,
            &mut open[task_index],
            bars.len(),
            &mut accumulator,
            &mut trades,
        );

        for position in open[task_index].drain(..) {
            if bars.is_empty() {
                continue;
            }
            let last = bar_at(bars, bars.len() - 1);
            trades.push(close_position(
                &task.symbol,
                &position,
                &last,
                last.close,
                crate::engine::sim::ExitReason::EndOfData,
                false,
                &task.sim,
            ));
        }
    }

    // The tail above appended out of order; the accumulator needs exit-time
    // order, so sort once and replay only the stragglers through it.
    trades.sort_unstable_by_key(|t| t.exit_time);

    let mut final_accumulator =
        MetricsAccumulator::new(request.sim.initial_balance, trades.len());
    for trade in &trades {
        final_accumulator.record(trade);
    }

    let (metrics, curve) = final_accumulator.finish();
    (metrics, curve, trades)
}

/// Resolves open positions against every bar up to (not including) `until`.
fn drain_closed(
    symbol: &str,
    bars: &Bars,
    config: &SimConfig,
    open: &mut Vec<OpenPosition>,
    until: usize,
    _accumulator: &mut MetricsAccumulator,
    trades: &mut Vec<Trade>,
) {
    if open.is_empty() {
        return;
    }

    let limit = until.min(bars.len());
    let mut still_open: Vec<OpenPosition> = Vec::with_capacity(open.len());

    for mut position in open.drain(..) {
        let mut closed = None;
        let mut i = position.scan_cursor;

        while i < limit {
            let bar = bar_at(bars, i);
            if let Some((price, reason, ambiguous)) = resolve_exit(&position, &bar, config) {
                closed = Some(close_position(
                    symbol, &position, &bar, price, reason, ambiguous, config,
                ));
                break;
            }
            position.track_excursion(&bar);
            i += 1;
        }

        match closed {
            Some(trade) => trades.push(trade),
            None => {
                // Resume here next time rather than re-walking from entry.
                position.scan_cursor = i;
                still_open.push(position);
            }
        }
    }

    *open = still_open;
}

#[inline]
fn bar_at(bars: &Bars, i: usize) -> BarSlice {
    BarSlice {
        index: i,
        time: bars.time()[i],
        open: bars.open_px()[i],
        high: bars.high()[i],
        low: bars.low()[i],
        close: bars.close()[i],
        spread_points: bars.spread()[i],
    }
}

/// Convenience for callers assembling tasks from a bar cache.
pub fn task_from_cache(
    root: &std::path::Path,
    symbol: &str,
    timeframe: Timeframe,
    higher: &[Timeframe],
    sim: SimConfig,
) -> Result<ScanTask> {
    let bars = Arc::new(Bars::open(crate::store::cache_path(root, symbol, timeframe)?)?);

    let higher = higher
        .iter()
        .map(|&tf| {
            Bars::open(crate::store::cache_path(root, symbol, tf)?).map(Arc::new)
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(ScanTask { bars, higher, sim })
}
