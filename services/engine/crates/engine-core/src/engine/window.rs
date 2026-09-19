//! The view a detector is given, and the guarantee it enforces.
//!
//! A detector never receives `&Bars`. It receives a [`BarCtx`], which exposes
//! the series only up to and including the current bar. There is no method on
//! it that reaches forward, so a lookahead bug is a compile error rather than
//! a suspiciously good equity curve.

use crate::engine::align::Alignment;
use crate::store::Bars;
use crate::timeframe::Timeframe;

/// A higher-timeframe series alongside the mapping from base bars into it.
pub struct HigherTimeframe<'a> {
    pub bars: &'a Bars,
    pub alignment: &'a Alignment,
}

/// Everything a detector may look at on one bar.
pub struct BarCtx<'a> {
    bars: &'a Bars,
    /// Index of the bar being evaluated. It has closed; nothing after it has.
    index: usize,
    higher: &'a [HigherTimeframe<'a>],
}

impl<'a> BarCtx<'a> {
    pub(crate) fn new(bars: &'a Bars, index: usize, higher: &'a [HigherTimeframe<'a>]) -> Self {
        debug_assert!(index < bars.len());
        BarCtx { bars, index, higher }
    }

    #[inline]
    pub fn index(&self) -> usize {
        self.index
    }

    #[inline]
    pub fn symbol(&self) -> &str {
        self.bars.symbol()
    }

    #[inline]
    pub fn timeframe(&self) -> Timeframe {
        self.bars.timeframe()
    }

    #[inline]
    pub fn time(&self) -> i64 {
        self.bars.time()[self.index]
    }

    #[inline]
    pub fn open(&self) -> f64 {
        self.bars.open_px()[self.index]
    }
    #[inline]
    pub fn high(&self) -> f64 {
        self.bars.high()[self.index]
    }
    #[inline]
    pub fn low(&self) -> f64 {
        self.bars.low()[self.index]
    }
    #[inline]
    pub fn close(&self) -> f64 {
        self.bars.close()[self.index]
    }
    #[inline]
    pub fn spread_points(&self) -> u16 {
        self.bars.spread()[self.index]
    }

    /// Value `n` bars back. `back(0)` is the current bar. `None` before the
    /// start of the series.
    #[inline]
    pub fn back(&self, n: usize) -> Option<usize> {
        self.index.checked_sub(n)
    }

    /// The last `n` closes ending at the current bar, as a contiguous slice.
    /// Shorter than `n` near the start of the series. Never includes a future
    /// bar — that is the whole point of routing access through here.
    #[inline]
    pub fn closes(&self, n: usize) -> &'a [f64] {
        let end = self.index + 1;
        &self.bars.close()[end.saturating_sub(n)..end]
    }

    #[inline]
    pub fn highs(&self, n: usize) -> &'a [f64] {
        let end = self.index + 1;
        &self.bars.high()[end.saturating_sub(n)..end]
    }

    #[inline]
    pub fn lows(&self, n: usize) -> &'a [f64] {
        let end = self.index + 1;
        &self.bars.low()[end.saturating_sub(n)..end]
    }

    /// Opens, on the same terms as the other three. Needed to tell a down-close
    /// candle from an up-close one, which `closes` alone cannot do.
    #[inline]
    pub fn opens(&self, n: usize) -> &'a [f64] {
        let end = self.index + 1;
        &self.bars.open_px()[end.saturating_sub(n)..end]
    }

    /// Higher-timeframe context, already restricted to closed bars.
    pub fn higher(&self, timeframe: Timeframe) -> Option<HigherBarCtx<'a>> {
        let slot = self
            .higher
            .iter()
            .find(|h| h.bars.timeframe() == timeframe)?;
        let higher_index = slot.alignment.at(self.index)?;
        Some(HigherBarCtx { bars: slot.bars, index: higher_index })
    }

    /// True when a higher-timeframe bar closed on this base bar — the cue to
    /// recompute that timeframe's state instead of reusing it.
    pub fn higher_just_closed(&self, timeframe: Timeframe) -> bool {
        self.higher
            .iter()
            .find(|h| h.bars.timeframe() == timeframe)
            .is_some_and(|h| h.alignment.is_fresh(self.index))
    }
}

/// A closed higher-timeframe bar.
pub struct HigherBarCtx<'a> {
    bars: &'a Bars,
    index: usize,
}

impl<'a> HigherBarCtx<'a> {
    #[inline]
    pub fn index(&self) -> usize {
        self.index
    }
    #[inline]
    pub fn time(&self) -> i64 {
        self.bars.time()[self.index]
    }
    #[inline]
    pub fn open(&self) -> f64 {
        self.bars.open_px()[self.index]
    }
    #[inline]
    pub fn high(&self) -> f64 {
        self.bars.high()[self.index]
    }
    #[inline]
    pub fn low(&self) -> f64 {
        self.bars.low()[self.index]
    }
    #[inline]
    pub fn close(&self) -> f64 {
        self.bars.close()[self.index]
    }

    #[inline]
    pub fn closes(&self, n: usize) -> &'a [f64] {
        let end = self.index + 1;
        &self.bars.close()[end.saturating_sub(n)..end]
    }

    #[inline]
    pub fn highs(&self, n: usize) -> &'a [f64] {
        let end = self.index + 1;
        &self.bars.high()[end.saturating_sub(n)..end]
    }

    #[inline]
    pub fn lows(&self, n: usize) -> &'a [f64] {
        let end = self.index + 1;
        &self.bars.low()[end.saturating_sub(n)..end]
    }
}
