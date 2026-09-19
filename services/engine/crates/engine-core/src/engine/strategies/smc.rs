//! Trend and order blocks, in the Smart Money Concepts sense.
//!
//! Spec: `docs/specs/2026-09-19-smc-order-blocks-design.md`. That document is
//! the authority on the rules; this is its implementation, and the two are
//! meant to be read together.
//!
//! The shape of it:
//!
//! 1. Structure is swing-based. A bar closing beyond the last *confirmed* swing
//!    sets the trend — a break of structure.
//! 2. The order block is the last opposing candle before the impulse that broke.
//!    Its range becomes a zone.
//! 3. A zone fires once, on the first bar that trades into its near edge.
//!
//! # What the engine forces
//!
//! There are no resting limit orders: a fill happens at the *next* bar's open at
//! market. So this detector cannot place an order at the zone edge and wait. It
//! waits itself, emits on the touch bar, and accepts a fill one bar later at
//! whatever the open is. That is worse than a limit fill, and it is the truth
//! about what this engine can execute.

use std::collections::HashMap;

use crate::engine::detector::{Detector, DetectorFactory, Direction, Signal, SignalSink};
use crate::engine::rolling::Atr;
use crate::engine::structure::{SwingTracker, Zone, ZoneBook};
use crate::engine::window::BarCtx;

pub const DETECTOR_NAME: &str = "smc_ob";

/// Bumped whenever a rule above changes. Recorded on every signal, because a
/// backtest from one version is not comparable with one from another (rule 6).
pub const DETECTOR_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SmcParams {
    /// Bars either side of a fractal swing.
    pub swing_lookback: usize,
    /// How far back to look for the opposing candle. Also bounds per-bar cost.
    pub ob_search_bars: usize,
    pub zone_max_age: usize,
    pub max_live_zones: usize,
    pub atr_period: usize,
    /// Stop distance beyond the zone's far edge, as a multiple of ATR.
    ///
    /// ATR rather than a fixed number of points on purpose: a pip is a
    /// different size on a JPY cross than on a 5-digit major, and a fixed buffer
    /// would be wrong on half the book. ATR is already in price units.
    pub atr_buffer: f64,
    pub target_r: f64,
    /// Require a fair value gap in the impulse leg. Off by default — it is a
    /// good filter that cuts signal count hard, and the first run needs volume.
    pub require_fvg: bool,
    pub warmup: usize,
}

impl Default for SmcParams {
    fn default() -> Self {
        SmcParams {
            swing_lookback: 5,
            ob_search_bars: 20,
            zone_max_age: 50,
            max_live_zones: 8,
            atr_period: 14,
            atr_buffer: 0.25,
            target_r: 2.0,
            require_fvg: false,
            warmup: 200,
        }
    }
}

pub struct SmcDetector {
    params: SmcParams,
    swings: SwingTracker,
    zones: ZoneBook,
    atr: Atr,
    /// `None` until the first break of structure. Nothing is taken before that:
    /// with no structure there is no side to be on.
    trend: Option<Direction>,
    /// Setups dropped because the touch bar closed past where the stop would
    /// sit — price went straight through the zone. Counted rather than silently
    /// discarded, so a run that finds nothing can be told apart from a run
    /// whose every setup was sliced.
    skipped_sliced: usize,
}

impl SmcDetector {
    pub fn new(params: SmcParams) -> Self {
        SmcDetector {
            swings: SwingTracker::new(params.swing_lookback),
            zones: ZoneBook::new(params.max_live_zones, params.zone_max_age),
            atr: Atr::new(params.atr_period),
            trend: None,
            skipped_sliced: 0,
            params,
        }
    }

    pub fn params(&self) -> &SmcParams {
        &self.params
    }

    pub fn trend(&self) -> Option<Direction> {
        self.trend
    }

    pub fn live_zones(&self) -> usize {
        self.zones.len()
    }

    pub fn skipped_sliced(&self) -> usize {
        self.skipped_sliced
    }

    /// Break of structure. A close beyond the last confirmed swing sets the
    /// trend and draws a zone from the impulse that did it.
    fn check_break(&mut self, ctx: &BarCtx<'_>) {
        let close = ctx.close();

        if let Some(swing) = self.swings.high() {
            if close > swing.price {
                self.trend = Some(Direction::Long);
                // Consumed, or this level breaks again on every later bar that
                // closes above it and one event becomes a signal per bar.
                self.swings.consume_high();
                self.draw_zone(ctx, Direction::Long, swing.price);
                return;
            }
        }

        if let Some(swing) = self.swings.low() {
            if close < swing.price {
                self.trend = Some(Direction::Short);
                self.swings.consume_low();
                self.draw_zone(ctx, Direction::Short, swing.price);
            }
        }
    }

    /// Finds the last opposing candle before this bar and books its range.
    fn draw_zone(&mut self, ctx: &BarCtx<'_>, direction: Direction, bos_price: f64) {
        // One extra so the window still holds `ob_search_bars` candidates once
        // the current bar is excluded.
        let n = self.params.ob_search_bars + 1;
        let opens = ctx.opens(n);
        let highs = ctx.highs(n);
        let lows = ctx.lows(n);
        let closes = ctx.closes(n);

        let len = closes.len();
        if len < 2 {
            return;
        }
        let current = len - 1;

        // Walk back from the bar before this one: the breaking bar is the
        // impulse, not the block it came from.
        let mut found = None;
        for k in (0..current).rev() {
            let opposing = match direction {
                Direction::Long => closes[k] < opens[k],
                Direction::Short => closes[k] > opens[k],
            };
            if opposing {
                found = Some(k);
                break;
            }
        }
        let Some(block) = found else { return };

        let fvg_present = has_gap(direction, highs, lows, block, current);
        if self.params.require_fvg && !fvg_present {
            return;
        }

        self.zones.insert(Zone {
            direction,
            high: highs[block],
            low: lows[block],
            created_index: ctx.index(),
            bos_price,
            fvg_present,
        });
    }

    fn build_signal(&mut self, zone: &Zone, ctx: &BarCtx<'_>) -> Option<Signal> {
        // Without a warm ATR there is no buffer, and the stop would sit exactly
        // on the zone edge where the spread alone would take it out.
        let atr = self.atr.value()?;
        if !(atr > 0.0) {
            return None;
        }

        let buffer = atr * self.params.atr_buffer;
        // The close is the best knowable stand-in for the next bar's open. The
        // simulator fills at that open regardless; this only has to be coherent
        // and to size the trade sensibly.
        let entry = ctx.close();
        let far = zone.far_edge();

        let (stop_loss, risk) = match zone.direction {
            Direction::Long => {
                let stop = far - buffer;
                (stop, entry - stop)
            }
            Direction::Short => {
                let stop = far + buffer;
                (stop, stop - entry)
            }
        };

        // Price went clean through the zone and closed past the stop. There is
        // no trade here, and emitting one would leave `is_coherent` to drop it
        // where nothing counts it.
        if !(risk > 0.0) {
            self.skipped_sliced += 1;
            return None;
        }

        let take_profit = match zone.direction {
            Direction::Long => entry + self.params.target_r * risk,
            Direction::Short => entry - self.params.target_r * risk,
        };

        let mut detail = HashMap::with_capacity(7);
        detail.insert("detector_version".to_string(), f64::from(DETECTOR_VERSION));
        detail.insert("zone_high".to_string(), zone.high);
        detail.insert("zone_low".to_string(), zone.low);
        detail.insert("bos_price".to_string(), zone.bos_price);
        detail.insert("trend_dir".to_string(), zone.direction.sign());
        detail.insert(
            "zone_age_bars".to_string(),
            ctx.index().saturating_sub(zone.created_index) as f64,
        );
        detail.insert(
            "fvg_present".to_string(),
            if zone.fvg_present { 1.0 } else { 0.0 },
        );

        Some(Signal {
            bar_index: ctx.index(),
            time: ctx.time(),
            direction: zone.direction,
            entry,
            stop_loss,
            take_profit: Some(take_profit),
            detail,
        })
    }
}

/// Is there a fair value gap between `from` and `to`?
///
/// The three-candle form: for a bullish leg, a bar whose predecessor's high sits
/// below its successor's low — price skipped a range outright.
fn has_gap(direction: Direction, highs: &[f64], lows: &[f64], from: usize, to: usize) -> bool {
    if to < from + 2 {
        return false;
    }
    (from + 1..to).any(|k| match direction {
        Direction::Long => highs[k - 1] < lows[k + 1],
        Direction::Short => lows[k - 1] > highs[k + 1],
    })
}

impl Detector for SmcDetector {
    fn name(&self) -> &str {
        DETECTOR_NAME
    }

    fn warmup(&self) -> usize {
        // Enough for a confirmed swing, a warm ATR, and a full block search
        // behind the first bar that could produce a signal.
        let minimum = self.swings.warmup() + self.params.atr_period + self.params.ob_search_bars;
        self.params.warmup.max(minimum)
    }

    fn on_bar(&mut self, ctx: &BarCtx<'_>, out: &mut SignalSink) {
        let index = ctx.index();
        let high = ctx.high();
        let low = ctx.low();
        let close = ctx.close();

        self.atr.push(high, low, close);
        self.swings.push(index, high, low);

        self.zones.expire(index);

        // Touch before break. A zone drawn by this bar is not eligible on it
        // anyway, but checking first keeps the two concerns from interleaving.
        if let Some(trend) = self.trend {
            if let Some(zone) = self.zones.take_touched(trend, index, high, low) {
                if let Some(signal) = self.build_signal(&zone, ctx) {
                    out.emit(signal);
                }
            }
        }

        self.check_break(ctx);

        // Last: a zone this close traded decisively beyond did not hold. Runs
        // after the break so a zone drawn by this bar is judged on the next one.
        self.zones.invalidate(close);
    }

    fn reset(&mut self) {
        self.swings.reset();
        self.zones.reset();
        // `Atr` has no reset and holds no heap, so a fresh one is the cheapest
        // way to clear the previous symbol's state.
        self.atr = Atr::new(self.params.atr_period);
        self.trend = None;
        self.skipped_sliced = 0;
    }
}

pub struct SmcFactory {
    params: SmcParams,
}

impl SmcFactory {
    pub fn new(params: SmcParams) -> Self {
        SmcFactory { params }
    }
}

impl Default for SmcFactory {
    fn default() -> Self {
        SmcFactory::new(SmcParams::default())
    }
}

impl DetectorFactory for SmcFactory {
    fn name(&self) -> &str {
        DETECTOR_NAME
    }

    fn version(&self) -> u32 {
        DETECTOR_VERSION
    }

    fn build(&self) -> Box<dyn Detector> {
        Box::new(SmcDetector::new(self.params))
    }
}

#[cfg(test)]
mod tests {
    //! Hand-built bars with every level known in advance, so each assertion is
    //! exact. Short windows keep the fixture readable: a swing needs two bars
    //! either side and ATR warms in three.

    use super::*;
    use crate::engine::window::HigherTimeframe;
    use crate::store::{write_bars, Bars, InputBar};
    use crate::Timeframe;

    fn params() -> SmcParams {
        SmcParams {
            swing_lookback: 2,
            ob_search_bars: 10,
            zone_max_age: 50,
            max_live_zones: 8,
            atr_period: 3,
            atr_buffer: 0.25,
            target_r: 2.0,
            require_fvg: false,
            warmup: 0,
        }
    }

    /// The bullish story, bar by bar:
    ///
    /// - 2 is a swing high at 1.1050, confirmed on bar 4.
    /// - 5 is a down-close candle: the order block, 1.1008 – 1.1032.
    /// - 6 closes at 1.1065, above the swing — the break of structure.
    /// - 7 pulls back but stays above the zone.
    /// - 8 trades down to 1.1025, inside the zone, and closes at 1.1040.
    fn bullish() -> Vec<(f64, f64, f64, f64)> {
        vec![
            (1.1000, 1.1010, 1.0990, 1.1005),
            (1.1005, 1.1012, 1.0992, 1.1008),
            (1.1008, 1.1050, 1.1000, 1.1040),
            (1.1025, 1.1030, 1.1010, 1.1015),
            (1.1015, 1.1028, 1.1005, 1.1010),
            (1.1025, 1.1032, 1.1008, 1.1012),
            (1.1012, 1.1070, 1.1010, 1.1065),
            (1.1065, 1.1068, 1.1045, 1.1050),
            (1.1050, 1.1052, 1.1025, 1.1040),
        ]
    }

    fn open_bars(tag: &str, ohlc: &[(f64, f64, f64, f64)]) -> Bars {
        let dir = std::env::temp_dir().join(format!("smc-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("EURUSD-H1.ttb");
        let input: Vec<InputBar> = ohlc
            .iter()
            .enumerate()
            .map(|(i, &(open, high, low, close))| InputBar {
                time: 1_700_000_000 + i as i64 * 3_600,
                open,
                high,
                low,
                close,
                volume: 100,
                spread: 2,
            })
            .collect();
        write_bars(&path, "EURUSD", Timeframe::H1, &input).unwrap();
        Bars::open(&path).unwrap()
    }

    /// Drives the detector over every bar and returns what it emitted.
    fn scan(detector: &mut SmcDetector, bars: &Bars) -> Vec<Signal> {
        let higher: [HigherTimeframe<'_>; 0] = [];
        let mut sink = SignalSink::with_capacity(8);
        for i in 0..bars.len() {
            let ctx = BarCtx::new(bars, i, &higher);
            detector.on_bar(&ctx, &mut sink);
        }
        sink.drain().collect()
    }

    #[test]
    fn a_break_then_a_touch_produces_exactly_one_long() {
        let bars = open_bars("one-long", &bullish());
        let mut detector = SmcDetector::new(params());
        let signals = scan(&mut detector, &bars);

        assert_eq!(signals.len(), 1, "one break, one zone, one touch");
        let s = &signals[0];
        assert_eq!(s.bar_index, 8, "fires on the touch bar");
        assert_eq!(s.direction, Direction::Long);
        assert_eq!(s.entry, 1.1040, "entry is the touch bar's close");
        assert_eq!(s.detail["zone_high"], 1.1032);
        assert_eq!(s.detail["zone_low"], 1.1008);
        assert_eq!(s.detail["bos_price"], 1.1050);
        assert_eq!(s.detail["detector_version"], f64::from(DETECTOR_VERSION));
        assert!(s.stop_loss < 1.1008, "stop sits beyond the far edge");
        let risk = s.entry - s.stop_loss;
        assert!((s.take_profit.unwrap() - (s.entry + 2.0 * risk)).abs() < 1e-12);
        assert!(s.is_coherent());
        assert_eq!(detector.trend(), Some(Direction::Long));
    }

    #[test]
    fn nothing_fires_before_the_first_break() {
        // Stop at bar 5: the swing is confirmed and the block exists, but nothing
        // has closed above the swing yet.
        let bars = open_bars("pre-break", &bullish()[..6]);
        let mut detector = SmcDetector::new(params());

        assert!(scan(&mut detector, &bars).is_empty());
        assert_eq!(detector.trend(), None, "no structure, no side");
        assert_eq!(detector.live_zones(), 0);
    }

    #[test]
    fn a_bar_slicing_through_the_zone_is_skipped_and_counted() {
        let mut ohlc = bullish();
        // Bar 8 falls straight through the zone and closes below where the
        // stop would sit.
        ohlc[8] = (1.1050, 1.1052, 1.0980, 1.0985);
        let bars = open_bars("sliced", &ohlc);
        let mut detector = SmcDetector::new(params());

        assert!(scan(&mut detector, &bars).is_empty(), "no trade on a sliced zone");
        assert_eq!(detector.skipped_sliced(), 1, "and it is counted, not silently dropped");
    }

    #[test]
    fn requiring_a_gap_suppresses_a_zone_without_one() {
        // The impulse is one bar, so there is no three-candle gap in it.
        let bars = open_bars("fvg", &bullish());
        let mut detector = SmcDetector::new(SmcParams { require_fvg: true, ..params() });

        assert!(scan(&mut detector, &bars).is_empty());
        assert_eq!(detector.trend(), Some(Direction::Long), "the break still sets the trend");
    }

    #[test]
    fn reset_clears_state_between_symbols() {
        let mut ohlc = bullish();
        ohlc[8] = (1.1050, 1.1052, 1.0980, 1.0985);
        let bars = open_bars("reset", &ohlc);
        let mut detector = SmcDetector::new(params());
        scan(&mut detector, &bars);

        detector.reset();
        assert_eq!(detector.trend(), None);
        assert_eq!(detector.live_zones(), 0);
        assert_eq!(detector.skipped_sliced(), 0);
    }

    #[test]
    fn warmup_covers_swing_atr_and_block_search() {
        let detector = SmcDetector::new(SmcParams { warmup: 0, ..SmcParams::default() });
        // 2 * 5 + 1 swing window, 14 for ATR, 20 for the block search.
        assert_eq!(detector.warmup(), 11 + 14 + 20);
        assert_eq!(SmcDetector::new(SmcParams::default()).warmup(), 200);
    }
}
