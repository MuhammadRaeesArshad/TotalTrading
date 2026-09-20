//! Multi-timeframe alignment, and the lookahead trap it exists to close.
//!
//! A strategy that reads H4 context while stepping M5 bars has to answer: at
//! M5 bar `i`, which H4 bar may I see? The only safe answer is *the last H4
//! bar that has already closed*. Reaching for the H4 bar that merely contains
//! `i` means reading a candle whose high, low and close have not happened yet
//! — the single most common way a backtest reports returns that cannot exist.
//!
//! This builds the mapping once, in a linear merge, so the lookup is an array
//! index in the hot loop rather than a search per bar.

use crate::store::Bars;
use crate::timeframe::Timeframe;

/// Sentinel for "no higher-timeframe bar has closed yet". `u32::MAX` rather
/// than an `Option<u32>` keeps the map at four bytes per entry, which for 20
/// million bars is the difference between 80 MB and 160 MB resident.
pub const NO_BAR: u32 = u32::MAX;

/// Maps each base-timeframe bar to the last *closed* higher-timeframe bar.
#[derive(Debug, Clone)]
pub struct Alignment {
    base_timeframe: Timeframe,
    higher_timeframe: Timeframe,
    map: Vec<u32>,
}

impl Alignment {
    /// Both series must be strictly increasing — [`Bars::open`] guarantees it.
    ///
    /// A higher-timeframe bar opening at `t` closes at `t + duration`. It is
    /// visible to a base bar opening at `b` only once `t + duration <= b`.
    ///
    /// One pass over each series: O(n + m), no search.
    pub fn build(base: &Bars, higher: &Bars) -> Self {
        let base_times = base.time();
        let higher_times = higher.time();
        let higher_duration = higher.timeframe().seconds();

        let mut map = Vec::with_capacity(base_times.len());
        let mut cursor: usize = 0;

        for &b in base_times {
            // Advance while the *next* higher bar has also closed by `b`.
            while cursor < higher_times.len() && higher_times[cursor] + higher_duration <= b {
                cursor += 1;
            }

            // `cursor` is the first bar not yet closed, so the last closed one
            // is the one before it.
            map.push(if cursor == 0 { NO_BAR } else { (cursor - 1) as u32 });
        }

        Alignment {
            base_timeframe: base.timeframe(),
            higher_timeframe: higher.timeframe(),
            map,
        }
    }

    /// Index of the last closed higher-timeframe bar at base bar `i`.
    #[inline]
    pub fn at(&self, i: usize) -> Option<usize> {
        match self.map.get(i).copied() {
            None | Some(NO_BAR) => None,
            Some(v) => Some(v as usize),
        }
    }

    /// True when `i` is the first base bar to see a newly closed higher bar —
    /// the moment higher-timeframe state should be recomputed rather than
    /// reused. Recomputing D1 and H4 only on close is the difference between
    /// one evaluation a day and 288 (build order step 4).
    #[inline]
    pub fn is_fresh(&self, i: usize) -> bool {
        match (self.map.get(i), i.checked_sub(1).and_then(|p| self.map.get(p))) {
            (Some(&current), Some(&previous)) => current != previous && current != NO_BAR,
            (Some(&current), None) => current != NO_BAR,
            _ => false,
        }
    }

    pub fn base_timeframe(&self) -> Timeframe {
        self.base_timeframe
    }

    pub fn higher_timeframe(&self) -> Timeframe {
        self.higher_timeframe
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}
