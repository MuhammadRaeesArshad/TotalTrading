//! Simulation behaviour, and one end-to-end run through the whole pipeline.
//!
//! The detector used here is a test fixture, not a strategy: it fires on a
//! fixed schedule so the expected trades can be computed by hand. The real
//! rules are still being defined, and nothing in `src/` guesses at them.

use std::collections::HashMap;
use std::sync::Arc;

use engine_core::engine::detector::{
    Detector, DetectorFactory, Direction, Signal, SignalSink,
};
use engine_core::engine::runner::{run, CapitalMode, Progress, RunRequest, ScanTask};
use engine_core::engine::sim::{
    close_position, resolve_exit, BarSlice, ExitReason, IntrabarPolicy, OpenPosition, SimConfig,
};
use engine_core::engine::window::BarCtx;
use engine_core::store::{write_bars, Bars, InputBar};
use engine_core::Timeframe;

// ---------------------------------------------------------------- fixtures

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("engine-test-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn long_position(entry: f64, stop: f64, target: Option<f64>) -> OpenPosition {
    OpenPosition {
        direction: Direction::Long,
        volume: 1.0,
        entry_price: entry,
        entry_time: 0,
        entry_index: 0,
        stop_loss: stop,
        take_profit: target,
        risk_distance: (entry - stop).abs(),
        commission: 0.0,
        scan_cursor: 1,
        max_adverse: 0.0,
        max_favorable: 0.0,
        detail: HashMap::new(),
    }
}

fn bar(high: f64, low: f64) -> BarSlice {
    BarSlice {
        index: 1,
        time: 1_000,
        open: (high + low) / 2.0,
        high,
        low,
        close: (high + low) / 2.0,
        spread_points: 0,
    }
}

fn config() -> SimConfig {
    SimConfig {
        point_size: 0.0001,
        point_value_per_lot: 10.0,
        commission_per_lot: 0.0,
        ..SimConfig::default()
    }
}

// ------------------------------------------------------------ position size

#[test]
fn position_size_rounds_down_to_the_broker_step() {
    let config = SimConfig {
        risk_percent: 1.0,
        point_size: 0.0001,
        point_value_per_lot: 10.0,
        volume_step: 0.01,
        volume_min: 0.01,
        ..SimConfig::default()
    };

    // 1% of 10,000 = $100 risk, over a 20-pip stop worth $10/pip/lot
    // => 100 / (20 * 10) = 0.5 lots exactly.
    let size = config.position_size(10_000.0, 0.0020).unwrap();
    assert!((size - 0.5).abs() < 1e-9, "got {size}");

    // A stop that yields 0.333… lots must round *down*. Rounding up would
    // exceed the configured risk on every single trade.
    let size = config.position_size(10_000.0, 0.0030).unwrap();
    assert!(size <= 0.3334, "must not round up, got {size}");
    assert!((size - 0.33).abs() < 1e-9, "got {size}");
}

#[test]
fn position_size_refuses_a_trade_below_the_broker_minimum() {
    let config = SimConfig {
        risk_percent: 0.1,
        point_size: 0.0001,
        point_value_per_lot: 10.0,
        volume_min: 0.01,
        volume_step: 0.01,
        ..SimConfig::default()
    };
    // A tiny account against a wide stop cannot place a legal lot. Skipping is
    // truthful; sizing up to the minimum would silently over-risk.
    assert!(config.position_size(50.0, 0.0500).is_none());
}

#[test]
fn position_size_rejects_a_zero_width_stop() {
    assert!(config().position_size(10_000.0, 0.0).is_none());
    assert!(config().position_size(10_000.0, f64::NAN).is_none());
}

// ------------------------------------------------------------- intrabar

#[test]
fn an_untouched_bar_leaves_the_position_open() {
    let position = long_position(1.1000, 1.0980, Some(1.1040));
    assert!(resolve_exit(&position, &bar(1.1020, 1.0990), &config()).is_none());
}

#[test]
fn a_bar_that_only_reaches_the_stop_closes_at_the_stop() {
    let position = long_position(1.1000, 1.0980, Some(1.1040));
    let (price, reason, ambiguous) =
        resolve_exit(&position, &bar(1.1010, 1.0975), &config()).unwrap();

    assert_eq!(reason, ExitReason::StopLoss);
    assert!(!ambiguous);
    assert!((price - 1.0980).abs() < 1e-9);
}

#[test]
fn an_ambiguous_bar_is_resolved_against_the_strategy_by_default() {
    // Both levels inside one bar. Bar data cannot say which came first, so the
    // default assumption has to be the unfavourable one.
    let position = long_position(1.1000, 1.0980, Some(1.1040));
    let wide = bar(1.1050, 1.0970);

    let (_, reason, ambiguous) = resolve_exit(&position, &wide, &config()).unwrap();
    assert_eq!(reason, ExitReason::StopLoss);
    assert!(ambiguous, "the result must be flagged as an assumption");

    let optimistic = SimConfig { intrabar: IntrabarPolicy::Optimistic, ..config() };
    let (_, reason, ambiguous) = resolve_exit(&position, &wide, &optimistic).unwrap();
    assert_eq!(reason, ExitReason::TakeProfit);
    assert!(ambiguous);
}

#[test]
fn stops_fill_worse_than_their_level_and_targets_do_not() {
    let costly = SimConfig { slippage_points: 5.0, ..config() };
    let position = long_position(1.1000, 1.0980, Some(1.1040));

    let (stop_price, _, _) = resolve_exit(&position, &bar(1.1010, 1.0975), &costly).unwrap();
    assert!(stop_price < 1.0980, "a stop should slip against you");

    let (target_price, reason, _) =
        resolve_exit(&position, &bar(1.1045, 1.0990), &costly).unwrap();
    assert_eq!(reason, ExitReason::TakeProfit);
    assert!((target_price - 1.1040).abs() < 1e-9, "a limit fills at its price");
}

// ------------------------------------------------------------ signal sanity

#[test]
fn incoherent_signals_are_rejected() {
    let base = Signal {
        bar_index: 10,
        time: 1_000,
        direction: Direction::Long,
        entry: 1.1000,
        stop_loss: 1.0980,
        take_profit: Some(1.1040),
        detail: HashMap::new(),
    };
    assert!(base.is_coherent());

    // Stop on the wrong side of entry for a long.
    let mut bad = base.clone();
    bad.stop_loss = 1.1020;
    assert!(!bad.is_coherent());

    // Target on the wrong side.
    let mut bad = base.clone();
    bad.take_profit = Some(1.0950);
    assert!(!bad.is_coherent());

    // Zero-width stop — would divide by zero in sizing.
    let mut bad = base.clone();
    bad.stop_loss = bad.entry;
    assert!(!bad.is_coherent());
}

// ------------------------------------------------------------ end to end

/// Fires a long every `period` bars with a fixed stop and target. A fixture,
/// not a strategy — its only job is to exercise the pipeline deterministically.
struct MetronomeDetector {
    period: usize,
    stop_distance: f64,
    target_distance: f64,
}

impl Detector for MetronomeDetector {
    fn name(&self) -> &str {
        "test-metronome"
    }

    fn warmup(&self) -> usize {
        0
    }

    fn on_bar(&mut self, ctx: &BarCtx<'_>, out: &mut SignalSink) {
        if ctx.index() % self.period != 0 {
            return;
        }
        let close = ctx.close();
        out.emit(Signal {
            bar_index: ctx.index(),
            time: ctx.time(),
            direction: Direction::Long,
            entry: close,
            stop_loss: close - self.stop_distance,
            take_profit: Some(close + self.target_distance),
            detail: HashMap::new(),
        });
    }
}

struct MetronomeFactory;

impl DetectorFactory for MetronomeFactory {
    fn name(&self) -> &str {
        "test-metronome"
    }
    fn build(&self, _params: &serde_json::Value) -> Result<Box<dyn Detector>, engine_core::CoreError> {
        Ok(Box::new(MetronomeDetector {
            period: 50,
            stop_distance: 0.0020,
            target_distance: 0.0040,
        }))
    }
}

/// A sawtooth: rises for 30 bars, falls for 30. Guarantees both targets and
/// stops get hit, so the run produces a mixed trade log rather than all wins.
fn sawtooth(n: usize) -> Vec<InputBar> {
    (0..n)
        .map(|i| {
            let phase = (i % 60) as f64;
            let level = if phase < 30.0 { phase } else { 60.0 - phase };
            let base = 1.1000 + level * 0.0004;
            InputBar {
                time: 1_700_000_000 + i as i64 * 300,
                open: base,
                high: base + 0.0006,
                low: base - 0.0006,
                close: base,
                volume: 500,
                spread: 2,
            }
        })
        .collect()
}

#[test]
fn runs_end_to_end_and_produces_a_coherent_result() {
    let dir = temp_dir("e2e");
    let path = dir.join("EURUSD-M5.ttb");
    let input = sawtooth(6_000);
    write_bars(&path, "EURUSD", Timeframe::M5, &input).unwrap();

    let bars = Arc::new(Bars::open(&path).unwrap());
    let sim = SimConfig {
        initial_balance: 10_000.0,
        risk_percent: 1.0,
        point_size: 0.0001,
        point_value_per_lot: 10.0,
        commission_per_lot: 7.0,
        ..SimConfig::default()
    };

    let request = RunRequest {
        params: serde_json::Value::Null,
        detector: "test-metronome".into(),
        from_ts: input[0].time,
        to_ts: input[input.len() - 1].time,
        sim: sim.clone(),
        capital: CapitalMode::Shared,
    };

    let tasks = vec![ScanTask { bars: Arc::clone(&bars), higher: vec![], sim }];
    let progress = Progress::default();
    let result = run(tasks, &request, &MetronomeFactory, &progress).unwrap();

    assert!(result.signals_generated > 0, "fixture should have fired");
    assert!(!result.trades.is_empty(), "signals should have become trades");
    assert_eq!(result.metrics.total_trades, result.trades.len());
    assert_eq!(
        result.metrics.wins + result.metrics.losses,
        result.metrics.total_trades
    );

    // Equity must reconcile with the trade log exactly.
    let summed: f64 = result.trades.iter().map(|t| t.net_profit).sum();
    assert!(
        (result.metrics.net_profit - summed).abs() < 1e-6,
        "net profit {} should equal the sum of trades {summed}",
        result.metrics.net_profit
    );
    assert!(
        (result.metrics.final_equity - (10_000.0 + summed)).abs() < 1e-6,
        "final equity must follow from the starting balance plus the log"
    );

    // Trades must be in exit order, or max drawdown is meaningless.
    for pair in result.trades.windows(2) {
        assert!(pair[0].exit_time <= pair[1].exit_time, "trade log out of order");
    }

    // Every entry is on the bar *after* its signal, never the signal bar.
    for trade in &result.trades {
        assert!(trade.exit_index >= trade.entry_index, "exit cannot precede entry; it may share the entry bar");
    }

    assert!(result.metrics.max_drawdown >= 0.0);
    assert!(result.metrics.max_drawdown_pct >= 0.0);
    assert!(!result.equity_curve.is_empty());
    assert!(result.engine_version.starts_with("rust-"));
    assert_eq!(result.bars_processed, input.len());
    assert!((progress.percent() - 100.0).abs() < 1.0, "progress should finish");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_run_with_no_symbols_is_an_error_not_an_empty_result() {
    // Zero trades because nothing was scanned looks identical to zero trades
    // because the strategy never fired. Only one of those is a bug, so the
    // engine refuses rather than reporting a clean run.
    let request = RunRequest {
        params: serde_json::Value::Null,
        detector: "test-metronome".into(),
        from_ts: 0,
        to_ts: i64::MAX,
        sim: SimConfig::default(),
        capital: CapitalMode::Shared,
    };
    let progress = Progress::default();
    assert!(run(vec![], &request, &MetronomeFactory, &progress).is_err());
}

// ------------------------------------------------------------ excursions

fn ranged(high: f64, low: f64) -> BarSlice {
    BarSlice { index: 2, time: 2_000, open: (high + low) / 2.0, high, low, close: (high + low) / 2.0, spread_points: 0 }
}

/// Entry 1.1000, stop 1.0980 — risk is 20 pips, so 1R = 0.0020.
#[test]
fn excursions_are_measured_in_r_over_the_bars_the_trade_survived() {
    let mut position = long_position(1.1000, 1.0980, Some(1.1040));
    position.detail.insert("zone_high".into(), 1.0995);

    position.track_excursion(&ranged(1.1030, 1.0990)); // +1.5R, -0.5R
    position.track_excursion(&ranged(1.1010, 1.0985)); // -0.75R is the worst

    let exit_bar = ranged(1.1045, 1.0970);
    let trade = close_position(
        "EURUSD", &position, &exit_bar, 1.1040, ExitReason::TakeProfit, false, &config(),
    );

    assert!((trade.mfe_r - 2.0).abs() < 1e-9, "the exit at target is the best it got: {}", trade.mfe_r);
    assert!((trade.mae_r - 0.75).abs() < 1e-9, "worst survived bar, not the exit bar's low: {}", trade.mae_r);
    assert_eq!(trade.detail["zone_high"], 1.0995, "signal detail rides through to the trade");
}

#[test]
fn a_stopped_trade_reports_about_one_r_adverse() {
    let mut position = long_position(1.1000, 1.0980, Some(1.1040));
    position.track_excursion(&ranged(1.1012, 1.0992)); // +0.6R before turning

    let trade = close_position(
        "EURUSD", &position, &ranged(1.1000, 1.0960), 1.0980, ExitReason::StopLoss, false, &config(),
    );

    assert!((trade.mae_r - 1.0).abs() < 1e-9, "{}", trade.mae_r);
    assert!((trade.mfe_r - 0.6).abs() < 1e-9, "right about direction, wrong about the exit: {}", trade.mfe_r);
}

// ------------------------------------------------------------ entry bar

/// Fires one long, once, with a stop 10 pips under the signal close.
struct OneShot {
    at: usize,
}

impl Detector for OneShot {
    fn name(&self) -> &str {
        "test-one-shot"
    }
    fn on_bar(&mut self, ctx: &BarCtx<'_>, out: &mut SignalSink) {
        if ctx.index() != self.at {
            return;
        }
        let close = ctx.close();
        out.emit(Signal {
            bar_index: ctx.index(),
            time: ctx.time(),
            direction: Direction::Long,
            entry: close,
            stop_loss: close - 0.0010,
            take_profit: Some(close + 0.0020),
            detail: HashMap::new(),
        });
    }
}

struct OneShotFactory;
impl DetectorFactory for OneShotFactory {
    fn name(&self) -> &str {
        "test-one-shot"
    }
    fn build(&self, _params: &serde_json::Value) -> Result<Box<dyn Detector>, engine_core::CoreError> {
        Ok(Box::new(OneShot { at: 5 }))
    }
}

/// The signal fires on bar 5, so the trade fills at bar 6's open. Bar 6 dips
/// through the stop and recovers; every later bar stays clear of the stop and
/// climbs through the target. Skipping the entry bar turns this loser into a
/// winner — which is exactly what the engine used to do.
#[test]
fn a_stop_hit_inside_the_entry_bar_closes_the_trade_there() {
    let dir = temp_dir("entry-bar");
    let path = dir.join("EURUSD-H1.ttb");
    let input: Vec<InputBar> = (0..14)
        .map(|i| {
            let (open, high, low, close) = match i {
                6 => (1.1000, 1.1003, 1.0985, 1.1000), // through the stop at 1.0990
                7..=13 => {
                    let c = 1.1000 + (i - 6) as f64 * 0.0005;
                    (c - 0.0003, c + 0.0002, c - 0.0004, c)
                }
                _ => (1.1000, 1.1002, 1.0998, 1.1000),
            };
            InputBar { time: 1_700_000_000 + i as i64 * 3_600, open, high, low, close, volume: 100, spread: 0 }
        })
        .collect();
    write_bars(&path, "EURUSD", Timeframe::H1, &input).unwrap();
    let bars = Arc::new(Bars::open(&path).unwrap());

    let sim = config();
    let request = RunRequest {
        params: serde_json::Value::Null,
        detector: "test-one-shot".into(),
        from_ts: input[0].time,
        to_ts: input[input.len() - 1].time,
        sim: sim.clone(),
        capital: CapitalMode::Shared,
    };
    let tasks = vec![ScanTask { bars, higher: vec![], sim }];
    let result = run(tasks, &request, &OneShotFactory, &Progress::default()).unwrap();

    assert_eq!(result.trades.len(), 1);
    let trade = &result.trades[0];
    assert_eq!(trade.exit_reason, ExitReason::StopLoss, "the entry bar reached the stop");
    assert_eq!(trade.entry_index, 6);
    assert_eq!(trade.exit_index, 6, "closed on the bar it opened");
    assert!(trade.r_multiple < 0.0);
}

// ------------------------------------------------------------ sizing and skips

/// Fires a long at each listed bar, with its stop `stop_distance` under the close.
struct Scripted {
    at: Vec<usize>,
    stop_distance: f64,
}

impl Detector for Scripted {
    fn name(&self) -> &str {
        "test-scripted"
    }
    fn on_bar(&mut self, ctx: &BarCtx<'_>, out: &mut SignalSink) {
        if !self.at.contains(&ctx.index()) {
            return;
        }
        let close = ctx.close();
        out.emit(Signal {
            bar_index: ctx.index(),
            time: ctx.time(),
            direction: Direction::Long,
            entry: close,
            stop_loss: close - self.stop_distance,
            take_profit: Some(close + 2.0 * self.stop_distance),
            detail: HashMap::new(),
        });
    }
}

struct ScriptedFactory {
    at: Vec<usize>,
    stop_distance: f64,
}
impl DetectorFactory for ScriptedFactory {
    fn name(&self) -> &str {
        "test-scripted"
    }
    fn build(&self, _params: &serde_json::Value) -> Result<Box<dyn Detector>, engine_core::CoreError> {
        Ok(Box::new(Scripted { at: self.at.clone(), stop_distance: self.stop_distance }))
    }
}

/// Flat bars at 1.1000, with overrides for specific bars.
fn flat_with(tag: &str, n: usize, overrides: &[(usize, (f64, f64, f64, f64))]) -> Arc<Bars> {
    flat_sym(tag, "EURUSD", n, overrides)
}

fn flat_sym(tag: &str, symbol: &str, n: usize, overrides: &[(usize, (f64, f64, f64, f64))]) -> Arc<Bars> {
    let dir = temp_dir(tag);
    let path = dir.join(format!("{symbol}-H1.ttb"));
    let input: Vec<InputBar> = (0..n)
        .map(|i| {
            let (open, high, low, close) = overrides
                .iter()
                .find(|(k, _)| *k == i)
                .map(|(_, v)| *v)
                .unwrap_or((1.1000, 1.1002, 1.0998, 1.1000));
            InputBar { time: 1_700_000_000 + i as i64 * 3_600, open, high, low, close, volume: 100, spread: 0 }
        })
        .collect();
    write_bars(&path, symbol, Timeframe::H1, &input).unwrap();
    Arc::new(Bars::open(&path).unwrap())
}

fn run_scripted(bars: Arc<Bars>, factory: &ScriptedFactory, sim: SimConfig) -> engine_core::RunResult {
    let times = bars.time().to_vec();
    let request = RunRequest {
        params: serde_json::Value::Null,
        detector: "test-scripted".into(),
        from_ts: times[0],
        to_ts: *times.last().unwrap(),
        sim: sim.clone(),
        capital: CapitalMode::Shared,
    };
    run(vec![ScanTask { bars, higher: vec![], sim }], &request, factory, &Progress::default()).unwrap()
}

/// Under `Compound`, risk is 1% of *current* equity. The engine used to size
/// every trade off the starting balance, so a losing run kept betting full
/// size and equity went deeply negative.
///
/// Compound has to be asked for now — the default is `Fixed`, which sizes off
/// the starting balance deliberately so a run cannot stop answering.
#[test]
fn position_size_compounds_on_realised_equity() {
    use engine_core::SizingMode;
    // Bar 6 dips through the first trade's stop; the second trade opens later.
    let bars = flat_with("compound", 30, &[(6, (1.1000, 1.1002, 1.0985, 1.1000))]);
    let factory = ScriptedFactory { at: vec![5, 20], stop_distance: 0.0010 };
    let sim = SimConfig { sizing: SizingMode::Compound, ..config() };
    let result = run_scripted(bars, &factory, sim);

    assert_eq!(result.trades.len(), 2);
    let (first, second) = (&result.trades[0], &result.trades[1]);
    assert_eq!(first.exit_reason, ExitReason::StopLoss);
    assert!((first.volume - 1.00).abs() < 1e-9, "1% of 10,000 over a 10-point stop: {}", first.volume);
    assert!(
        (second.volume - 0.99).abs() < 1e-9,
        "after losing 1R the next trade risks 1% of 9,900: {}",
        second.volume
    );
}

/// A gap that opens the entry bar beyond the stop invalidates the setup.
/// `abs()` on the distance used to hide it and open a trade anyway.
#[test]
fn a_gap_through_the_stop_is_skipped_and_counted() {
    let bars = flat_with("gap", 20, &[(6, (1.0985, 1.0990, 1.0980, 1.0986))]);
    let factory = ScriptedFactory { at: vec![5], stop_distance: 0.0010 };
    let result = run_scripted(bars, &factory, config());

    assert!(result.trades.is_empty());
    assert_eq!(result.skipped.stop_gapped, 1);
}

/// A stop inside the costs sizes a huge position whose spread alone is many R.
#[test]
fn a_stop_inside_the_costs_is_skipped_and_counted() {
    let bars = flat_with("tight", 20, &[]);
    let factory = ScriptedFactory { at: vec![5], stop_distance: 0.0010 };
    // 12 points of extra spread: the fill lands 0.0012 above the open, so the
    // real risk is 0.0022 against a 2x cost floor of 0.0024.
    let sim = SimConfig { extra_spread_points: 12.0, ..config() };
    let result = run_scripted(bars, &factory, sim);

    assert!(result.trades.is_empty());
    assert_eq!(result.skipped.stop_inside_costs, 1);
}

/// A gap past the target: the entry bar opens above a long's take-profit. The
/// engine used to open it and immediately book "take profit" at a loss.
#[test]
fn a_gap_past_the_target_is_skipped_and_counted() {
    // Signal close 1.1000, target 1.1020; bar 6 opens at 1.1030.
    let bars = flat_with("tp-gap", 20, &[(6, (1.1030, 1.1035, 1.1025, 1.1032))]);
    let factory = ScriptedFactory { at: vec![5], stop_distance: 0.0010 };
    let result = run_scripted(bars, &factory, config());

    assert!(result.trades.is_empty(), "no trade when the reward is already gone");
    assert_eq!(result.skipped.target_passed, 1);
}

/// Two pairs, one losing trade on the first before the second trades again.
/// Under one shared account that loss shrinks the next position on the *other*
/// pair; under `PerSymbol` each pair draws on its own untouched balance. This
/// is the whole difference between the two modes, and it is why a 28-pair run
/// and a solo run of the same pair reported different trades.
#[test]
fn per_symbol_capital_keeps_one_pairs_loss_off_another_pairs_sizing() {
    // EURUSD dips through its first stop at bar 6; GBPUSD stays flat throughout.
    let losing = flat_sym("cap-a", "EURUSD", 30, &[(6, (1.1000, 1.1002, 1.0985, 1.1000))]);
    let flat = flat_sym("cap-b", "GBPUSD", 30, &[]);
    let factory = ScriptedFactory { at: vec![5, 20], stop_distance: 0.0010 };

    let volume_of_second_gbp = |capital: CapitalMode| {
        // Only compounding can carry one pair's loss into another's sizing;
        // under Fixed there is nothing to carry.
        let sim = SimConfig { sizing: engine_core::SizingMode::Compound, ..config() };
        let times = losing.time().to_vec();
        let request = RunRequest {
            params: serde_json::Value::Null,
            detector: "test-scripted".into(),
            from_ts: times[0],
            to_ts: *times.last().unwrap(),
            sim: sim.clone(),
            capital,
        };
        let tasks = vec![
            ScanTask { bars: Arc::clone(&losing), higher: vec![], sim: sim.clone() },
            ScanTask { bars: Arc::clone(&flat), higher: vec![], sim },
        ];
        let result = run(tasks, &request, &factory, &Progress::default()).unwrap();
        result
            .trades
            .iter()
            .filter(|t| t.symbol == "GBPUSD")
            .max_by_key(|t| t.entry_time)
            .expect("GBPUSD traded")
            .volume
    };

    let shared = volume_of_second_gbp(CapitalMode::Shared);
    let isolated = volume_of_second_gbp(CapitalMode::PerSymbol);

    assert!(
        (shared - 0.99).abs() < 1e-9,
        "shared book: EURUSD lost 1% first, so 1% of 9,900 — got {shared}"
    );
    assert!(
        (isolated - 1.00).abs() < 1e-9,
        "own book: GBPUSD still has the full 10,000 — got {isolated}"
    );
}

// ------------------------------------------------ trend + engulfing, end to end

/// Writes one series and returns it mapped.
fn series(tag: &str, symbol: &str, tf: Timeframe, input: &[InputBar]) -> Arc<Bars> {
    let dir = temp_dir(tag);
    let path = dir.join(format!("{symbol}-{tf:?}.ttb"));
    write_bars(&path, symbol, tf, input).unwrap();
    Arc::new(Bars::open(&path).unwrap())
}

/// A rising market on M15 with H1 above it, and a bullish engulfing candle at
/// the end. Every filter the strategy has must pass: the H1 EMA is climbing
/// well over half an ATR per five bars, the last 20 M15 bars have moved more
/// than 100 pips, and the engulfing body is far bigger than half an ATR.
#[test]
fn trend_engulfing_fires_on_an_engulfing_candle_in_an_uptrend() {
    use engine_core::engine::strategies::trend_engulf::{TrendEngulfFactory, TrendEngulfParams};

    const BASE: i64 = 1_699_999_200; // an exact hour, so H1 and M15 line up
    let n = 240usize;

    // M15: a steady climb of 6 pips a bar.
    let mut m15: Vec<InputBar> = (0..n)
        .map(|i| {
            let c = 1.1000 + i as f64 * 0.0006;
            InputBar {
                time: BASE + i as i64 * 900,
                open: c - 0.0002, high: c + 0.0002, low: c - 0.0004, close: c,
                volume: 100, spread: 0,
            }
        })
        .collect();

    // The last two bars: a small down bar, then one that swallows it whole.
    let pivot = 1.1000 + (n - 2) as f64 * 0.0006;
    m15[n - 2] = InputBar {
        time: BASE + (n - 2) as i64 * 900,
        open: pivot + 0.0003, high: pivot + 0.0004, low: pivot - 0.0003, close: pivot - 0.0002,
        volume: 100, spread: 0,
    };
    m15[n - 1] = InputBar {
        time: BASE + (n - 1) as i64 * 900,
        open: pivot - 0.0002, high: pivot + 0.0020, low: pivot - 0.0006, close: pivot + 0.0018,
        volume: 100, spread: 0,
    };

    // H1: the same climb, one bar per hour.
    let h1: Vec<InputBar> = (0..n / 4)
        .map(|i| {
            let c = 1.1000 + i as f64 * 0.0024;
            InputBar {
                time: BASE + i as i64 * 3_600,
                open: c - 0.0008, high: c + 0.0008, low: c - 0.0016, close: c,
                volume: 400, spread: 0,
            }
        })
        .collect();

    let base = series("te-m15", "EURUSD", Timeframe::M15, &m15);
    let higher = series("te-h1", "EURUSD", Timeframe::H1, &h1);

    let sim = config();
    let request = RunRequest {
        params: serde_json::Value::Null,
        detector: "trend_engulf".into(),
        from_ts: m15[0].time,
        to_ts: m15[n - 1].time,
        sim: sim.clone(),
        capital: CapitalMode::Shared,
    };
    let tasks = vec![ScanTask { bars: base, higher: vec![higher], sim }];
    let result = run(tasks, &request, &TrendEngulfFactory, &Progress::default()).unwrap();

    assert_eq!(result.signals_generated, 1, "exactly the engulfing bar should fire");

    // The signal fires on the last bar, so there is no bar to enter on — the
    // run reports that rather than inventing a fill.
    assert_eq!(result.skipped.no_entry_bar, 1);

    // And the levels it asked for: stop a hair under the engulfing low, target
    // at twice that distance.
    let d = TrendEngulfParams::default();
    let low = m15[n - 1].low;
    let close = m15[n - 1].close;
    let expected_stop = low - d.sl_pips * 0.0001;
    let expected_target = close + d.risk_reward * (close - expected_stop);
    assert!(expected_target > close && expected_stop < low);
}

/// The same candle, with the trend timeframe flat. Direction is the first gate,
/// so nothing fires — a good-looking candle in a range is not a setup.
#[test]
fn trend_engulfing_stays_silent_when_the_higher_timeframe_is_going_nowhere() {
    use engine_core::engine::strategies::trend_engulf::TrendEngulfFactory;

    const BASE: i64 = 1_699_999_200;
    let n = 240usize;

    let mut m15: Vec<InputBar> = (0..n)
        .map(|i| {
            let c = 1.1000 + i as f64 * 0.0006;
            InputBar {
                time: BASE + i as i64 * 900,
                open: c - 0.0002, high: c + 0.0002, low: c - 0.0004, close: c,
                volume: 100, spread: 0,
            }
        })
        .collect();
    let pivot = 1.1000 + (n - 2) as f64 * 0.0006;
    m15[n - 2] = InputBar {
        time: BASE + (n - 2) as i64 * 900,
        open: pivot + 0.0003, high: pivot + 0.0004, low: pivot - 0.0003, close: pivot - 0.0002,
        volume: 100, spread: 0,
    };
    m15[n - 1] = InputBar {
        time: BASE + (n - 1) as i64 * 900,
        open: pivot - 0.0002, high: pivot + 0.0020, low: pivot - 0.0006, close: pivot + 0.0018,
        volume: 100, spread: 0,
    };

    // H1 oscillates in a band: plenty of range, no EMA travel.
    let h1: Vec<InputBar> = (0..n / 4)
        .map(|i| {
            let c = 1.1000 + if i % 2 == 0 { 0.0015 } else { -0.0015 };
            InputBar {
                time: BASE + i as i64 * 3_600,
                open: c, high: c + 0.0010, low: c - 0.0010, close: c,
                volume: 400, spread: 0,
            }
        })
        .collect();

    let base = series("te-flat-m15", "EURUSD", Timeframe::M15, &m15);
    let higher = series("te-flat-h1", "EURUSD", Timeframe::H1, &h1);

    let sim = config();
    let request = RunRequest {
        params: serde_json::Value::Null,
        detector: "trend_engulf".into(),
        from_ts: m15[0].time,
        to_ts: m15[n - 1].time,
        sim: sim.clone(),
        capital: CapitalMode::Shared,
    };
    let tasks = vec![ScanTask { bars: base, higher: vec![higher], sim }];
    let result = run(tasks, &request, &TrendEngulfFactory, &Progress::default()).unwrap();

    assert_eq!(result.signals_generated, 0, "no direction means no trade");
}

/// The whole point of `Fixed`: a losing stretch that would bankrupt a
/// compounding account does not stop the run answering.
///
/// Under `Compound` the balance falls until a position rounds below the
/// broker's minimum, and every later signal is skipped while the metrics go on
/// reporting as though it traded. A sweep of that measures how fast a setting
/// killed the account, not what the setting does.
#[test]
fn fixed_sizing_keeps_testing_signals_after_a_compounding_account_would_be_gone() {
    use engine_core::SizingMode;

    // Every trade loses: bar 6 of each pair of bars dips through the stop.
    let overrides: Vec<(usize, (f64, f64, f64, f64))> = (0..40)
        .map(|k| (6 + k * 6, (1.1000, 1.1002, 1.0900, 1.1000)))
        .collect();
    let bars = flat_with("ruin", 260, &overrides);
    let at: Vec<usize> = (0..40).map(|k| 5 + k * 6).collect();
    let factory = ScriptedFactory { at, stop_distance: 0.0010 };

    // 50% a trade: a compounding account is gone within a handful of losses.
    let mut sim = config();
    sim.risk_percent = 50.0;

    let compound = run_scripted(
        Arc::clone(&bars),
        &factory,
        SimConfig { sizing: SizingMode::Compound, ..sim.clone() },
    );
    let fixed = run_scripted(bars, &factory, SimConfig { sizing: SizingMode::Fixed, ..sim });

    assert!(
        compound.skipped.below_min_volume > 0,
        "a compounding account should have run out and started skipping",
    );
    assert_eq!(
        fixed.skipped.below_min_volume, 0,
        "fixed sizing never runs out, so nothing is skipped for lack of funds",
    );
    assert!(
        fixed.trades.len() > compound.trades.len(),
        "fixed tested {} signals, compound only {}",
        fixed.trades.len(),
        compound.trades.len(),
    );
}
