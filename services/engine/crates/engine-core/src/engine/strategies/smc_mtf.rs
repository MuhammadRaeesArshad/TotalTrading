//! Multi-timeframe Smart Money Concepts — the user's own strategy.
//!
//! Spec: `docs/specs/2026-09-20-smc-mtf-design.md`.
//!
//! 1. **Direction** comes from the higher timeframes. Each of H4 and H1 is
//!    bullish or bearish by the direction of its last swing break of structure.
//!    How they combine is configurable (`trend_mode`), because the right
//!    answer differs by pair.
//! 2. **Setup** is a break of structure on M15 *or* M30, in that direction:
//!    bearish means a higher high, then a lower low.
//! 3. **Entry** is the order block that break came from — the last opposing
//!    candle before the impulse, which is where the next lower high should
//!    form. Filled on the first touch.
//! 4. **Exit** is a stop just beyond the block and a fixed R target.
//!
//! Timeframes it needs: M15 to run on, with M30, H1 and H4 loaded alongside.
//! A missing higher timeframe means no direction, and therefore no trades —
//! silence rather than a guess.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::engine::detector::{
    params_from, Detector, DetectorFactory, Direction, Signal, SignalSink,
};
use crate::engine::rolling::Atr;
use crate::engine::structure::{SwingTracker, Zone, ZoneBook};
use crate::engine::window::BarCtx;
use crate::error::Result;
use crate::timeframe::Timeframe;

pub const DETECTOR_NAME: &str = "smc_mtf";
pub const DETECTOR_VERSION: u32 = 1;

/// How the two higher timeframes decide the tradeable direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrendMode {
    /// H4 and H1 must point the same way. Strictest, and the default.
    BothAgree,
    /// H4 alone decides; H1 is ignored.
    H4Only,
    /// H1 alone decides.
    H1Only,
    /// Either one agreeing is enough. Most trades, weakest filter.
    Either,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MtfParams {
    /// Swing size on H4 and H1, where structure is coarser.
    pub trend_swing_lookback: usize,
    /// Swing size on M15 and M30, where the entries are found.
    pub entry_swing_lookback: usize,
    pub ob_search_bars: usize,
    pub zone_max_age: usize,
    pub max_live_zones: usize,
    pub atr_period: usize,
    /// Stop distance beyond the block's far edge, in ATR.
    pub atr_buffer: f64,
    pub target_r: f64,
    pub trend_mode: TrendMode,
    /// Also take breaks of structure on M30, not only M15.
    pub entry_on_m30: bool,
    pub warmup: usize,
}

impl Default for MtfParams {
    fn default() -> Self {
        MtfParams {
            trend_swing_lookback: 5,
            entry_swing_lookback: 3,
            ob_search_bars: 20,
            zone_max_age: 80,
            max_live_zones: 8,
            atr_period: 14,
            atr_buffer: 0.25,
            target_r: 2.0,
            trend_mode: TrendMode::BothAgree,
            entry_on_m30: true,
            warmup: 400,
        }
    }
}

/// Structure on one timeframe: confirmed swings, and the direction of the last
/// break. Used for the higher timeframes' trend and for the entry timeframes.
#[derive(Debug, Clone)]
struct Structure {
    swings: SwingTracker,
    trend: Option<Direction>,
    /// Bar index of the last break, so a zone is drawn only once per break.
    last_break: Option<usize>,
    broken_level: f64,
}

impl Structure {
    fn new(lookback: usize) -> Self {
        Structure {
            swings: SwingTracker::new(lookback),
            trend: None,
            last_break: None,
            broken_level: f64::NAN,
        }
    }

    /// Feeds one closed bar. Returns the direction when this bar broke
    /// structure, so the caller can draw a zone from it.
    fn push(&mut self, index: usize, high: f64, low: f64, close: f64) -> Option<Direction> {
        self.swings.push(index, high, low);

        if let Some(swing) = self.swings.high() {
            if close > swing.price {
                self.swings.consume_high();
                self.trend = Some(Direction::Long);
                self.last_break = Some(index);
                self.broken_level = swing.price;
                return Some(Direction::Long);
            }
        }
        if let Some(swing) = self.swings.low() {
            if close < swing.price {
                self.swings.consume_low();
                self.trend = Some(Direction::Short);
                self.last_break = Some(index);
                self.broken_level = swing.price;
                return Some(Direction::Short);
            }
        }
        None
    }

    fn reset(&mut self) {
        self.swings.reset();
        self.trend = None;
        self.last_break = None;
        self.broken_level = f64::NAN;
    }
}

pub struct MtfDetector {
    params: MtfParams,
    h4: Structure,
    h1: Structure,
    m30: Structure,
    base: Structure,
    zones: ZoneBook,
    atr: Atr,
    /// Index of the last M30 bar folded in, so each closed M30 bar counts once.
    m30_seen: usize,
    skipped_sliced: usize,
}

impl MtfDetector {
    pub fn new(params: MtfParams) -> Self {
        MtfDetector {
            h4: Structure::new(params.trend_swing_lookback),
            h1: Structure::new(params.trend_swing_lookback),
            m30: Structure::new(params.entry_swing_lookback),
            base: Structure::new(params.entry_swing_lookback),
            zones: ZoneBook::new(params.max_live_zones, params.zone_max_age),
            atr: Atr::new(params.atr_period),
            m30_seen: usize::MAX,
            skipped_sliced: 0,
            params,
        }
    }

    pub fn trend(&self) -> Option<Direction> {
        self.allowed()
    }

    pub fn live_zones(&self) -> usize {
        self.zones.len()
    }

    pub fn skipped_sliced(&self) -> usize {
        self.skipped_sliced
    }

    /// The direction trades may be taken in, from the higher timeframes.
    fn allowed(&self) -> Option<Direction> {
        let (h4, h1) = (self.h4.trend, self.h1.trend);
        match self.params.trend_mode {
            TrendMode::BothAgree => match (h4, h1) {
                (Some(a), Some(b)) if a == b => Some(a),
                _ => None,
            },
            TrendMode::H4Only => h4,
            TrendMode::H1Only => h1,
            TrendMode::Either => match (h4, h1) {
                (Some(a), Some(b)) if a != b => None,
                (Some(a), _) => Some(a),
                (_, b) => b,
            },
        }
    }

    /// Draws the order block behind a break: the last opposing candle before
    /// the impulse. `opens`/`highs`/`lows`/`closes` end at the breaking bar.
    #[allow(clippy::too_many_arguments)]
    fn draw_zone(
        &mut self,
        direction: Direction,
        opens: &[f64],
        highs: &[f64],
        lows: &[f64],
        closes: &[f64],
        broken_level: f64,
        created_index: usize,
    ) {
        let len = closes.len();
        if len < 2 {
            return;
        }
        let current = len - 1;

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

        self.zones.insert(Zone {
            direction,
            high: highs[block],
            low: lows[block],
            created_index,
            bos_price: broken_level,
            fvg_present: false,
        });
    }

    fn build_signal(&mut self, zone: &Zone, ctx: &BarCtx<'_>) -> Option<Signal> {
        let atr = self.atr.value()?;
        if !(atr > 0.0) {
            return None;
        }
        let buffer = atr * self.params.atr_buffer;
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
        // Price went clean through the block and closed past the stop.
        if !(risk > 0.0) {
            self.skipped_sliced += 1;
            return None;
        }

        let take_profit = match zone.direction {
            Direction::Long => entry + self.params.target_r * risk,
            Direction::Short => entry - self.params.target_r * risk,
        };

        let mut detail = HashMap::with_capacity(8);
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
            "h4_trend".to_string(),
            self.h4.trend.map(|d| d.sign()).unwrap_or(0.0),
        );
        detail.insert(
            "h1_trend".to_string(),
            self.h1.trend.map(|d| d.sign()).unwrap_or(0.0),
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

impl Detector for MtfDetector {
    fn name(&self) -> &str {
        DETECTOR_NAME
    }

    fn warmup(&self) -> usize {
        // H4 structure needs the most base bars: 16 M15 bars per H4 bar, and a
        // swing needs 2 * lookback + 1 of them before it confirms.
        let h4_bars = (2 * self.params.trend_swing_lookback + 1) * 16;
        self.params.warmup.max(h4_bars + self.params.ob_search_bars)
    }

    fn on_bar(&mut self, ctx: &BarCtx<'_>, out: &mut SignalSink) {
        let index = ctx.index();
        let (high, low, close) = (ctx.high(), ctx.low(), ctx.close());
        self.atr.push(high, low, close);

        // Higher timeframes, folded in only on the bar where each one closes.
        for (tf, which) in [(Timeframe::H4, 0u8), (Timeframe::H1, 1)] {
            if !ctx.higher_just_closed(tf) {
                continue;
            }
            let Some(h) = ctx.higher(tf) else { continue };
            let structure = if which == 0 { &mut self.h4 } else { &mut self.h1 };
            structure.push(h.index(), h.high(), h.low(), h.close());
        }

        self.zones.expire(index);

        // Entry structure on M30: a break here draws a zone from M30 candles.
        if self.params.entry_on_m30 && ctx.higher_just_closed(Timeframe::M30) {
            if let Some(h) = ctx.higher(Timeframe::M30) {
                if h.index() != self.m30_seen {
                    self.m30_seen = h.index();
                    let broke = self.m30.push(h.index(), h.high(), h.low(), h.close());
                    if let Some(direction) = broke {
                        if self.allowed() == Some(direction) {
                            let n = self.params.ob_search_bars + 1;
                            let level = self.m30.broken_level;
                            self.draw_zone(
                                direction, h.opens(n), h.highs(n), h.lows(n), h.closes(n), level, index,
                            );
                        }
                    }
                }
            }
        }

        // A zone fires on the first base bar that trades into it.
        if let Some(direction) = self.allowed() {
            if let Some(zone) = self.zones.take_touched(direction, index, high, low) {
                if let Some(signal) = self.build_signal(&zone, ctx) {
                    out.emit(signal);
                }
            }
        }

        // Entry structure on the base timeframe.
        if let Some(direction) = self.base.push(index, high, low, close) {
            if self.allowed() == Some(direction) {
                let n = self.params.ob_search_bars + 1;
                let level = self.base.broken_level;
                self.draw_zone(
                    direction, ctx.opens(n), ctx.highs(n), ctx.lows(n), ctx.closes(n), level, index,
                );
            }
        }

        self.zones.invalidate(close);
    }

    fn reset(&mut self) {
        self.h4.reset();
        self.h1.reset();
        self.m30.reset();
        self.base.reset();
        self.zones.reset();
        self.atr = Atr::new(self.params.atr_period);
        self.m30_seen = usize::MAX;
        self.skipped_sliced = 0;
    }
}

pub struct MtfFactory {
    params: MtfParams,
}

impl MtfFactory {
    pub fn new(params: MtfParams) -> Self {
        MtfFactory { params }
    }
}

impl Default for MtfFactory {
    fn default() -> Self {
        MtfFactory::new(MtfParams::default())
    }
}

impl DetectorFactory for MtfFactory {
    fn name(&self) -> &str {
        DETECTOR_NAME
    }

    fn version(&self) -> u32 {
        DETECTOR_VERSION
    }

    fn description(&self) -> &str {
        "Multi-timeframe Smart Money Concepts. H4 and H1 set the direction by \
         their last break of structure, and trades are taken only that way. On \
         M15 (and M30) a break in that direction — a higher high into a lower \
         low, for a short — draws the order block it came from. The trade is \
         the first touch of that block, where the next lower high should form, \
         with a stop just beyond the block and a fixed R target."
    }

    fn timeframes(&self) -> (&str, Vec<&str>) {
        ("M15", vec!["M30", "H1", "H4"])
    }

    fn params_schema(&self) -> serde_json::Value {
        let d = MtfParams::default();
        json!([
            { "key": "trend_mode", "label": "Direction from", "kind": "choice", "default": "both_agree",
              "options": [
                { "value": "both_agree", "label": "H4 and H1 must agree" },
                { "value": "h4_only", "label": "H4 only" },
                { "value": "h1_only", "label": "H1 only" },
                { "value": "either", "label": "Either, unless they conflict" }
              ],
              "help": "Set per pair: some trend cleanly on H4, others need both." },
            { "key": "entry_on_m30", "label": "Also break on M30", "kind": "bool", "default": d.entry_on_m30,
              "help": "Off means entries come from M15 breaks alone." },
            { "key": "trend_swing_lookback", "label": "Swing size, H4 and H1", "kind": "int",
              "default": d.trend_swing_lookback, "min": 2, "max": 20,
              "help": "Bars either side of a swing on the trend timeframes." },
            { "key": "entry_swing_lookback", "label": "Swing size, M15 and M30", "kind": "int",
              "default": d.entry_swing_lookback, "min": 2, "max": 20,
              "help": "Smaller finds more breaks, and more noise." },
            { "key": "ob_search_bars", "label": "Order block search", "kind": "int", "default": d.ob_search_bars,
              "min": 3, "max": 60, "help": "How far back to look for the opposing candle." },
            { "key": "zone_max_age", "label": "Zone lifetime", "kind": "int", "default": d.zone_max_age,
              "min": 5, "max": 500, "help": "Bars before an untouched block expires." },
            { "key": "atr_buffer", "label": "Stop buffer (ATR)", "kind": "float", "default": d.atr_buffer,
              "min": 0.0, "max": 2.0, "step": 0.05, "help": "Stop distance beyond the block, in ATR." },
            { "key": "target_r", "label": "Target (R)", "kind": "float", "default": d.target_r,
              "min": 0.5, "max": 10.0, "step": 0.5, "help": "Take profit, as a multiple of risk." }
        ])
    }

    fn build(&self, params: &serde_json::Value) -> Result<Box<dyn Detector>> {
        let p = if params.is_null() { self.params } else { params_from::<MtfParams>(params)? };
        Ok(Box::new(MtfDetector::new(p)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detector(mode: TrendMode) -> MtfDetector {
        MtfDetector::new(MtfParams { trend_mode: mode, ..MtfParams::default() })
    }

    /// The trend gate is the whole point of the strategy: no agreement, no trade.
    #[test]
    fn both_agree_requires_both_timeframes() {
        let mut d = detector(TrendMode::BothAgree);
        assert_eq!(d.allowed(), None, "nothing until structure exists");

        d.h4.trend = Some(Direction::Short);
        assert_eq!(d.allowed(), None, "H4 alone is not enough");

        d.h1.trend = Some(Direction::Long);
        assert_eq!(d.allowed(), None, "disagreement means no side");

        d.h1.trend = Some(Direction::Short);
        assert_eq!(d.allowed(), Some(Direction::Short));
    }

    #[test]
    fn single_timeframe_modes_ignore_the_other() {
        let mut d = detector(TrendMode::H4Only);
        d.h4.trend = Some(Direction::Long);
        d.h1.trend = Some(Direction::Short);
        assert_eq!(d.allowed(), Some(Direction::Long));

        let mut d = detector(TrendMode::H1Only);
        d.h4.trend = Some(Direction::Long);
        d.h1.trend = Some(Direction::Short);
        assert_eq!(d.allowed(), Some(Direction::Short));
    }

    #[test]
    fn either_takes_whichever_has_spoken_but_never_a_conflict() {
        let mut d = detector(TrendMode::Either);
        d.h4.trend = Some(Direction::Long);
        assert_eq!(d.allowed(), Some(Direction::Long), "H1 silent, H4 decides");

        d.h1.trend = Some(Direction::Short);
        assert_eq!(d.allowed(), None, "a conflict is still no trade");
    }

    /// A break sets the trend and reports itself once, so one break draws one zone.
    #[test]
    fn structure_breaks_once_per_swing() {
        let mut s = Structure::new(2);
        let bars = [
            (1.0, 0.5, 0.8), (1.1, 0.6, 0.9), (1.5, 0.7, 1.4),
            (1.2, 0.6, 1.0), (1.05, 0.55, 0.9),
        ];
        for (i, (h, l, c)) in bars.iter().enumerate() {
            assert_eq!(s.push(i, *h, *l, *c), None, "no close above the swing yet");
        }
        assert_eq!(s.push(5, 1.6, 1.0, 1.55), Some(Direction::Long), "closes above 1.5");
        assert_eq!(s.trend, Some(Direction::Long));
        assert_eq!(s.push(6, 1.7, 1.5, 1.65), None, "the level is consumed, not broken again");
    }

    #[test]
    fn settings_round_trip_and_reject_typos() {
        let p: MtfParams = params_from(&json!({ "trend_mode": "h4_only", "target_r": 3.0 })).unwrap();
        assert_eq!(p.trend_mode, TrendMode::H4Only);
        assert_eq!(p.target_r, 3.0);
        assert_eq!(p.atr_buffer, MtfParams::default().atr_buffer, "unset keys keep their default");

        assert!(params_from::<MtfParams>(&json!({ "targt_r": 3.0 })).is_err(), "a typo must not run different rules");
        assert!(params_from::<MtfParams>(&json!({ "trend_mode": "sideways" })).is_err());
    }
}
