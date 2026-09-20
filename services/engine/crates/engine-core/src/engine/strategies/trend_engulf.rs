//! Trend + Engulfing — ported from the user's `finance-trader-backend`.
//!
//! Spec: `docs/specs/2026-09-20-trend-engulfing-design.md`, which also lists
//! where this port deviates from the Python original and why.
//!
//! 1. **Direction** is the higher timeframe's EMA slope, measured in ATRs so
//!    the same threshold works on a quiet pair and a violent one. Sideways is
//!    a third state, not a coin flip — it simply does not trade.
//! 2. **Trigger** is a full engulfing candle in that direction: it takes out
//!    both of the previous bar's extremes and closes past one of them.
//! 3. **Filter** rejects a setup when the last 20 bars went nowhere. An
//!    engulfing bar inside a range is noise.
//! 4. **Trade** is a stop just past the engulfing candle and a fixed R target.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::engine::detector::{
    params_from, Detector, DetectorFactory, Direction, Signal, SignalSink,
};
use crate::engine::rolling::{Atr, Ema, Lag};
use crate::engine::window::BarCtx;
use crate::error::Result;
use crate::timeframe::Timeframe;

pub const DETECTOR_NAME: &str = "trend_engulf";
pub const DETECTOR_VERSION: u32 = 1;

/// Where the direction is read from. The original derived this from the base
/// timeframe; a factory declares its timeframes before it sees any parameters,
/// so here it is a choice and the base stays M15.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TrendTf {
    /// The original's mapping for an M15 base.
    H1,
    H4,
}

impl TrendTf {
    fn timeframe(self) -> Timeframe {
        match self {
            TrendTf::H1 => Timeframe::H1,
            TrendTf::H4 => Timeframe::H4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TrendEngulfParams {
    pub trend_timeframe: TrendTf,
    /// The EMA that stands in for the trend line.
    pub ema_period: usize,
    /// How many trend bars back the slope is measured over.
    pub slope_window: usize,
    /// How far the EMA must travel, in ATRs, to count as directional.
    pub atr_threshold: f64,
    /// Minimum body as a fraction of ATR — the doji filter.
    pub min_body_atr: f64,
    /// Bars back for the range check.
    pub consolidation_lookback: usize,
    /// Minimum net move over that lookback, in pips.
    pub consolidation_pips: f64,
    /// Stop buffer beyond the engulfing candle's extreme, in pips.
    pub sl_pips: f64,
    /// Target as a multiple of the stop distance.
    pub risk_reward: f64,
}

impl Default for TrendEngulfParams {
    fn default() -> Self {
        // Every default is the Python original's, so a run here starts from
        // the settings the user already judged good.
        TrendEngulfParams {
            trend_timeframe: TrendTf::H1,
            ema_period: 21,
            slope_window: 5,
            atr_threshold: 0.5,
            min_body_atr: 0.5,
            consolidation_lookback: 20,
            consolidation_pips: 100.0,
            sl_pips: 5.0,
            risk_reward: 2.0,
        }
    }
}

/// What the EMA slope says about the trend timeframe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trend {
    Up,
    Down,
    /// Sideways, or not enough history yet. Both mean no trade.
    None,
}

/// The original's discriminator: quotes above 10 are the JPY crosses, which
/// quote to 3 decimals. Crude, and kept because the thresholds it feeds were
/// tuned against it — a "pip" here has to mean what it meant there.
fn pip_size(price: f64) -> f64 {
    if price > 10.0 {
        0.01
    } else {
        0.0001
    }
}

pub struct TrendEngulfDetector {
    params: TrendEngulfParams,
    trend_tf: Timeframe,

    /// Body filter, on the base timeframe.
    atr: Atr,

    /// Trend timeframe state, stepped only when one of its bars closes.
    ema: Ema,
    trend_atr: Atr,
    ema_then: Lag,
    trend: Trend,
    /// Guards against folding the same trend bar in twice.
    trend_seen: usize,
}

impl TrendEngulfDetector {
    pub fn new(params: TrendEngulfParams) -> Self {
        TrendEngulfDetector {
            trend_tf: params.trend_timeframe.timeframe(),
            atr: Atr::new(14),
            ema: Ema::new(params.ema_period),
            trend_atr: Atr::new(14),
            ema_then: Lag::new(params.slope_window),
            trend: Trend::None,
            trend_seen: usize::MAX,
            params,
        }
    }

    /// Folds one closed trend bar in and re-reads the slope.
    fn step_trend(&mut self, high: f64, low: f64, close: f64) {
        self.ema.push(close);
        self.trend_atr.push(high, low, close);

        let Some(now) = self.ema.value() else {
            self.trend = Trend::None;
            return;
        };
        // Only a settled EMA belongs in the lag buffer; seeding values would
        // make the first slope a measurement of the seed, not of price.
        self.ema_then.push(now);

        let (Some(then), Some(atr)) = (self.ema_then.value(), self.trend_atr.value()) else {
            self.trend = Trend::None;
            return;
        };
        if atr <= 0.0 {
            self.trend = Trend::None;
            return;
        }

        let score = (now - then) / atr;
        self.trend = if score > self.params.atr_threshold {
            Trend::Up
        } else if score < -self.params.atr_threshold {
            Trend::Down
        } else {
            Trend::None
        };
    }

    /// True when the last `consolidation_lookback` bars actually went
    /// somewhere. Not enough history does not block — same as the original.
    fn moved_enough(&self, ctx: &BarCtx<'_>) -> bool {
        let n = self.params.consolidation_lookback + 1;
        let closes = ctx.closes(n);
        if closes.len() < n {
            return true;
        }
        let net = (ctx.close() - closes[0]).abs() / pip_size(ctx.close());
        net >= self.params.consolidation_pips
    }
}

impl Detector for TrendEngulfDetector {
    fn name(&self) -> &str {
        DETECTOR_NAME
    }

    fn warmup(&self) -> usize {
        // The trend timeframe needs ema_period + slope_window of its own bars
        // before it says anything, and each one spans several base bars.
        let per_trend_bar = (self.trend_tf.seconds() / Timeframe::M15.seconds()).max(1) as usize;
        let trend_bars = self.params.ema_period + self.params.slope_window + 14;
        (trend_bars * per_trend_bar).max(self.params.consolidation_lookback + 2)
    }

    fn on_bar(&mut self, ctx: &BarCtx<'_>, out: &mut SignalSink) {
        let (high, low, close, open) = (ctx.high(), ctx.low(), ctx.close(), ctx.open());
        self.atr.push(high, low, close);

        // Direction, refreshed only on the bar where a trend bar closes.
        if ctx.higher_just_closed(self.trend_tf) {
            if let Some(h) = ctx.higher(self.trend_tf) {
                if h.index() != self.trend_seen {
                    self.trend_seen = h.index();
                    self.step_trend(h.high(), h.low(), h.close());
                }
            }
        }

        let direction = match self.trend {
            Trend::Up => Direction::Long,
            Trend::Down => Direction::Short,
            Trend::None => return,
        };

        // The previous bar, for the engulfing comparison.
        let opens = ctx.opens(2);
        let highs = ctx.highs(2);
        let lows = ctx.lows(2);
        let closes = ctx.closes(2);
        if closes.len() < 2 {
            return;
        }
        let (prev_open, prev_high, prev_low, prev_close) = (opens[0], highs[0], lows[0], closes[0]);

        // Wicks included: the bar has to cover the whole of the previous one.
        if !(low < prev_low && high > prev_high) {
            return;
        }

        let engulfs = match direction {
            Direction::Long => prev_close < prev_open && close > prev_high && close > open,
            Direction::Short => prev_close > prev_open && close < prev_low && close < open,
        };
        if !engulfs {
            return;
        }

        // A body that small is a doji dressed as a signal. Unlike the original
        // this waits for ATR rather than letting the bar through without it.
        let Some(atr) = self.atr.value() else { return };
        if atr <= 0.0 || (close - open).abs() < self.params.min_body_atr * atr {
            return;
        }

        if !self.moved_enough(ctx) {
            return;
        }

        let buffer = self.params.sl_pips * pip_size(close);
        let (stop, risk) = match direction {
            Direction::Long => {
                let stop = low - buffer;
                (stop, close - stop)
            }
            Direction::Short => {
                let stop = high + buffer;
                (stop, stop - close)
            }
        };
        if risk <= 0.0 {
            return;
        }
        let target = close + self.params.risk_reward * risk * direction.sign();

        // Why it fired, carried on the trade so the results page can show it.
        let mut detail = HashMap::new();
        detail.insert("body_atr".to_string(), (close - open).abs() / atr);
        detail.insert("engulf_high".to_string(), high);
        detail.insert("engulf_low".to_string(), low);
        detail.insert("risk_reward".to_string(), self.params.risk_reward);

        out.emit(Signal {
            bar_index: ctx.index(),
            time: ctx.time(),
            direction,
            entry: close,
            stop_loss: stop,
            take_profit: Some(target),
            detail,
        });
    }
}

#[derive(Default)]
pub struct TrendEngulfFactory;

impl DetectorFactory for TrendEngulfFactory {
    fn name(&self) -> &str {
        DETECTOR_NAME
    }

    fn version(&self) -> u32 {
        DETECTOR_VERSION
    }

    fn description(&self) -> &str {
        "Trend plus engulfing. The higher timeframe sets direction by how far \
         its EMA has travelled, measured in ATRs so the same threshold suits a \
         quiet pair and a violent one; sideways does not trade. The entry is a \
         candle that swallows the previous one whole — both wicks — and closes \
         past it in the trend's direction, with a body of at least half an ATR \
         so a doji cannot qualify. Setups inside a range are dropped. The stop \
         sits just beyond the engulfing candle and the target at a fixed R."
    }

    fn timeframes(&self) -> (&str, Vec<&str>) {
        ("M15", vec!["H1", "H4"])
    }

    fn params_schema(&self) -> serde_json::Value {
        let d = TrendEngulfParams::default();
        json!([
            { "key": "trend_timeframe", "label": "Direction from", "kind": "choice", "default": "H1",
              "options": [
                { "value": "H1", "label": "H1" },
                { "value": "H4", "label": "H4" }
              ],
              "help": "H1 is the original's choice for an M15 base. H4 trades less and filters harder." },
            { "key": "ema_period", "label": "EMA period", "kind": "int", "default": d.ema_period,
              "min": 2, "max": 200, "help": "The trend line the slope is read from." },
            { "key": "slope_window", "label": "Slope over", "kind": "int", "default": d.slope_window,
              "min": 1, "max": 50, "help": "Trend-timeframe bars between the two EMA readings." },
            { "key": "atr_threshold", "label": "Slope threshold, in ATRs", "kind": "float",
              "default": d.atr_threshold, "min": 0.0, "max": 5.0, "step": 0.1,
              "help": "Below this in either direction the trend counts as sideways and nothing trades." },
            { "key": "min_body_atr", "label": "Minimum body, in ATRs", "kind": "float",
              "default": d.min_body_atr, "min": 0.0, "max": 5.0, "step": 0.1,
              "help": "Keeps a doji from passing as an engulfing candle." },
            { "key": "consolidation_lookback", "label": "Range check, bars", "kind": "int",
              "default": d.consolidation_lookback, "min": 0, "max": 500,
              "help": "How far back the net-move filter looks." },
            { "key": "consolidation_pips", "label": "Range check, minimum pips", "kind": "float",
              "default": d.consolidation_pips, "min": 0.0, "max": 1000.0, "step": 5.0,
              "help": "Net move over that many bars. Below it the setup is inside a range and is dropped." },
            { "key": "sl_pips", "label": "Stop buffer, pips", "kind": "float", "default": d.sl_pips,
              "min": 0.0, "max": 200.0, "step": 0.5,
              "help": "Beyond the engulfing candle's low for a long, its high for a short." },
            { "key": "risk_reward", "label": "Target, in R", "kind": "float", "default": d.risk_reward,
              "min": 0.5, "max": 10.0, "step": 0.5, "help": "Target distance as a multiple of the stop." }
        ])
    }

    fn build(&self, params: &serde_json::Value) -> Result<Box<dyn Detector>> {
        let params: TrendEngulfParams = params_from(params)?;
        Ok(Box::new(TrendEngulfDetector::new(params)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detector() -> TrendEngulfDetector {
        TrendEngulfDetector::new(TrendEngulfParams::default())
    }

    #[test]
    fn a_rising_ema_reads_as_an_uptrend_once_the_slope_clears_the_threshold() {
        let mut d = detector();
        // A steady climb: the EMA travels far more than one ATR per 5 bars.
        for i in 0..60 {
            let c = 1.1000 + i as f64 * 0.0020;
            d.step_trend(c + 0.0005, c - 0.0005, c);
        }
        assert_eq!(d.trend, Trend::Up);
    }

    #[test]
    fn a_falling_ema_reads_as_a_downtrend() {
        let mut d = detector();
        for i in 0..60 {
            let c = 1.3000 - i as f64 * 0.0020;
            d.step_trend(c + 0.0005, c - 0.0005, c);
        }
        assert_eq!(d.trend, Trend::Down);
    }

    #[test]
    fn a_flat_market_is_sideways_and_never_directional() {
        let mut d = detector();
        // Oscillating within a band: plenty of ATR, no net EMA travel.
        for i in 0..80 {
            let c = 1.1000 + if i % 2 == 0 { 0.0010 } else { -0.0010 };
            d.step_trend(c + 0.0008, c - 0.0008, c);
        }
        assert_eq!(d.trend, Trend::None, "a range must not produce a direction");
    }

    /// The threshold is in ATRs, so the same drift in a volatile market is not
    /// a trend. This is the whole reason the slope is normalised.
    #[test]
    fn the_same_drift_is_not_a_trend_when_volatility_is_high() {
        let mut quiet = detector();
        let mut wild = detector();
        for i in 0..60 {
            let c = 1.1000 + i as f64 * 0.0002;
            quiet.step_trend(c + 0.0001, c - 0.0001, c);
            wild.step_trend(c + 0.0100, c - 0.0100, c);
        }
        assert_eq!(quiet.trend, Trend::Up);
        assert_eq!(wild.trend, Trend::None, "the same drift, swamped by range");
    }

    #[test]
    fn params_reject_a_key_that_is_not_a_setting() {
        let bad = json!({ "atr_threshold": 0.5, "not_a_setting": 1 });
        assert!(TrendEngulfFactory.build(&bad).is_err());
    }

    #[test]
    fn params_override_only_what_they_name() {
        let p: TrendEngulfParams = params_from(&json!({ "risk_reward": 3.0 })).unwrap();
        assert_eq!(p.risk_reward, 3.0);
        assert_eq!(p.ema_period, 21, "everything else keeps the original's default");
    }

    #[test]
    fn jpy_crosses_use_a_larger_pip() {
        assert_eq!(pip_size(157.25), 0.01);
        assert_eq!(pip_size(1.0850), 0.0001);
    }
}
