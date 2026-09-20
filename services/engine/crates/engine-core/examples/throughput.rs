//! Throughput harness. Generates a synthetic series, writes it to the bar
//! cache, and times a full scan through the real pipeline.
//!
//!   cargo run --release --example throughput -- 5000000
//!
//! Always measure in release. The debug build is roughly fifty times slower
//! and tells you nothing useful.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use engine_core::engine::detector::{
    Detector, DetectorFactory, Direction, Signal, SignalSink,
};
use engine_core::engine::rolling::{Atr, MonotonicWindow};
use engine_core::engine::runner::{run, Progress, RunRequest, ScanTask};
use engine_core::engine::window::BarCtx;
use engine_core::store::{write_bars, Bars, InputBar};
use engine_core::{SimConfig, Timeframe};

/// Representative load, not a strategy: a 200-bar rolling high/low plus ATR,
/// which is roughly the indicator weight a real rule set carries.
struct LoadDetector {
    high: MonotonicWindow,
    low: MonotonicWindow,
    atr: Atr,
    fired: usize,
}

impl Default for LoadDetector {
    fn default() -> Self {
        LoadDetector {
            high: MonotonicWindow::max(200),
            low: MonotonicWindow::min(200),
            atr: Atr::new(14),
            fired: 0,
        }
    }
}

impl Detector for LoadDetector {
    fn name(&self) -> &str {
        "throughput-load"
    }

    fn warmup(&self) -> usize {
        200
    }

    fn on_bar(&mut self, ctx: &BarCtx<'_>, out: &mut SignalSink) {
        // Read the window *before* pushing this bar, so "broke the 200-bar
        // high" compares against the prior 200 bars rather than against a
        // range this bar is already inside. Pushing first makes the condition
        // unsatisfiable, which is a quiet way to benchmark nothing.
        let prior = (self.high.value(), self.low.value(), self.atr.value());

        self.high.push(ctx.high());
        self.low.push(ctx.low());
        self.atr.push(ctx.high(), ctx.low(), ctx.close());

        let (Some(high), Some(low), Some(atr)) = prior else {
            return;
        };

        // Breakout of the rolling high, stopped an ATR below. Chosen because it
        // fires often enough to load the simulator, not because it is good.
        if ctx.close() >= high && atr > 0.0 {
            self.fired += 1;
            if self.fired % 500 != 0 {
                return;
            }
            let entry = ctx.close();
            out.emit(Signal {
                bar_index: ctx.index(),
                time: ctx.time(),
                direction: Direction::Long,
                entry,
                stop_loss: entry - atr,
                take_profit: Some(entry + atr * 2.0),
                detail: HashMap::from([("atr".into(), atr), ("range_low".into(), low)]),
            });
        }
    }

    fn reset(&mut self) {
        *self = LoadDetector::default();
    }
}

struct LoadFactory;
impl DetectorFactory for LoadFactory {
    fn name(&self) -> &str {
        "throughput-load"
    }
    fn build(&self, _params: &serde_json::Value) -> Result<Box<dyn Detector>, engine_core::CoreError> {
        Ok(Box::<LoadDetector>::default())
    }
}

fn synthetic(n: usize) -> Vec<InputBar> {
    const ANCHOR: f64 = 1.1000;
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut price = ANCHOR;

    (0..n)
        .map(|i| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;

            // Take the top 32 bits over a 2^32 divisor for a clean [0, 1).
            // Shifting one bit too far yields [0, 0.5) and a shock that is
            // always negative — the walk then drifts out of any plausible FX
            // range and no breakout ever triggers.
            let unit = (state >> 32) as f64 / 4_294_967_296.0;
            let shock = (unit - 0.5) * 0.0012;

            // Gentle pull back to the anchor. A pure random walk over millions
            // of bars wanders arbitrarily far; this keeps prices FX-shaped
            // without flattening the short-run structure the detector reads.
            let pull = (ANCHOR - price) * 0.0005;

            let open = price;
            let close = price + shock + pull;
            let high = open.max(close) + 0.0003;
            let low = open.min(close) - 0.0003;
            price = close;

            InputBar {
                time: 1_500_000_000 + i as i64 * 300,
                open,
                high,
                low,
                close,
                volume: 400,
                spread: 2,
            }
        })
        .collect()
}

fn main() {
    let count: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(1_000_000);

    let dir = std::env::temp_dir().join("ttb-throughput");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("EURUSD-M5.ttb");

    println!("generating {count} bars…");
    let generated = Instant::now();
    let input = synthetic(count);
    println!("  generated in {:?}", generated.elapsed());

    let written = Instant::now();
    write_bars(&path, "EURUSD", Timeframe::M5, &input).unwrap();
    let bytes = std::fs::metadata(&path).unwrap().len();
    println!(
        "  wrote {:.1} MiB in {:?}",
        bytes as f64 / 1_048_576.0,
        written.elapsed()
    );
    drop(input);

    let mapped = Instant::now();
    let bars = Arc::new(Bars::open(&path).unwrap());
    println!("  mapped {} bars in {:?}", bars.len(), mapped.elapsed());

    let sim = SimConfig {
        point_size: 0.0001,
        point_value_per_lot: 10.0,
        ..SimConfig::default()
    };
    let request = RunRequest {
        detector: "throughput-load".into(),
        params: serde_json::Value::Null,
        from_ts: i64::MIN,
        to_ts: i64::MAX,
        sim: sim.clone(),
    };

    let progress = Progress::default();
    let started = Instant::now();
    let result = run(
        vec![ScanTask { bars, higher: vec![], sim }],
        &request,
        &LoadFactory,
        &progress,
    )
    .unwrap();
    let elapsed = started.elapsed();

    let per_second = count as f64 / elapsed.as_secs_f64();
    println!("\nscan: {count} bars in {elapsed:?}");
    println!("  {:.2} M bars/sec", per_second / 1_000_000.0);
    println!("  {:.1} ns/bar", elapsed.as_nanos() as f64 / count as f64);
    println!(
        "  {} signals, {} trades, net {:.2}",
        result.signals_generated, result.metrics.total_trades, result.metrics.net_profit
    );

    std::fs::remove_dir_all(&dir).ok();
}
