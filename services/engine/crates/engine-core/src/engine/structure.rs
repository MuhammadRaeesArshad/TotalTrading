//! Market-structure primitives: confirmed swing points, and a book of price
//! zones with a lifecycle.
//!
//! Neither type knows what strategy is using it. Swings and zones are what
//! every structure-based rule set is built from, so they live here rather than
//! inside one strategy's module — the next one gets them for free.
//!
//! Both are fixed-capacity and allocate nothing per bar, because the `Detector`
//! contract requires it.

use std::collections::VecDeque;

use crate::engine::detector::Direction;

/// A swing point, anchored to the bar that made it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SwingPoint {
    pub index: usize,
    pub price: f64,
}

/// Finds fractal swing highs and lows.
///
/// A swing high is a bar whose high is strictly above the highs of `lookback`
/// bars on *both* sides. Strictly, not `>=`: a flat top would otherwise confirm
/// two swings at the same price and break structure twice on one level.
///
/// # The lag is real
///
/// A swing at bar `i` cannot be known until bar `i + lookback` has closed, so
/// that is when this reports it. Nothing here compensates for the delay, and
/// nothing should: a live scanner learns about structure on exactly the same
/// schedule, and a backtest that knew sooner would be measuring a strategy
/// nobody can trade.
#[derive(Debug, Clone)]
pub struct SwingTracker {
    lookback: usize,
    /// The last `2 * lookback + 1` bars as (high, low).
    window: VecDeque<(f64, f64)>,
    /// Absolute index of the most recently pushed bar.
    newest: usize,
    high: Option<SwingPoint>,
    low: Option<SwingPoint>,
}

impl SwingTracker {
    pub fn new(lookback: usize) -> Self {
        assert!(lookback > 0, "swing lookback must be at least 1 bar");
        SwingTracker {
            lookback,
            window: VecDeque::with_capacity(2 * lookback + 1),
            newest: 0,
            high: None,
            low: None,
        }
    }

    /// Bars needed before this can confirm anything.
    pub fn warmup(&self) -> usize {
        2 * self.lookback + 1
    }

    pub fn push(&mut self, index: usize, high: f64, low: f64) {
        self.newest = index;
        self.window.push_back((high, low));
        if self.window.len() > self.warmup() {
            self.window.pop_front();
        }
        if self.window.len() < self.warmup() {
            return;
        }

        // The candidate sits in the middle, `lookback` bars back from newest.
        let mid = self.lookback;
        let candidate_index = index - self.lookback;
        let (mid_high, mid_low) = self.window[mid];

        let mut is_high = true;
        let mut is_low = true;
        for (offset, &(h, l)) in self.window.iter().enumerate() {
            if offset == mid {
                continue;
            }
            if h >= mid_high {
                is_high = false;
            }
            if l <= mid_low {
                is_low = false;
            }
            if !is_high && !is_low {
                break;
            }
        }

        // A bar that engulfs its neighbours on both sides is both, so these are
        // not exclusive.
        if is_high {
            self.high = Some(SwingPoint { index: candidate_index, price: mid_high });
        }
        if is_low {
            self.low = Some(SwingPoint { index: candidate_index, price: mid_low });
        }
    }

    /// Most recent confirmed swing high, if one has been seen.
    #[inline]
    pub fn high(&self) -> Option<SwingPoint> {
        self.high
    }

    #[inline]
    pub fn low(&self) -> Option<SwingPoint> {
        self.low
    }

    /// Discards the stored swing high.
    ///
    /// Called once a break has used it. Without this the same level breaks on
    /// every subsequent bar that closes above it, turning one structural event
    /// into a signal per bar for the rest of the trend.
    #[inline]
    pub fn consume_high(&mut self) {
        self.high = None;
    }

    #[inline]
    pub fn consume_low(&mut self) {
        self.low = None;
    }

    pub fn reset(&mut self) {
        self.window.clear();
        self.newest = 0;
        self.high = None;
        self.low = None;
    }
}

/// A price zone waiting to be traded into.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Zone {
    /// The trade this zone would produce, not the direction price moves to reach it.
    pub direction: Direction,
    pub high: f64,
    pub low: f64,
    /// Bar the zone became live — the break, not the candle it was drawn from.
    pub created_index: usize,
    /// The level whose break created this zone. Carried for the audit trail.
    pub bos_price: f64,
    pub fvg_present: bool,
}

impl Zone {
    /// The edge price reaches first on its way back. Long zones sit below price,
    /// so the top is nearest.
    #[inline]
    pub fn near_edge(&self) -> f64 {
        match self.direction {
            Direction::Long => self.high,
            Direction::Short => self.low,
        }
    }

    /// The edge a stop goes beyond.
    #[inline]
    pub fn far_edge(&self) -> f64 {
        match self.direction {
            Direction::Long => self.low,
            Direction::Short => self.high,
        }
    }

    #[inline]
    fn is_touched_by(&self, high: f64, low: f64) -> bool {
        match self.direction {
            Direction::Long => low <= self.high,
            Direction::Short => high >= self.low,
        }
    }

    /// A close beyond the far edge means the zone did not hold.
    #[inline]
    fn is_violated_by(&self, close: f64) -> bool {
        match self.direction {
            Direction::Long => close < self.low,
            Direction::Short => close > self.high,
        }
    }
}

/// Fixed-capacity book of live zones, oldest first.
///
/// Capacity is a hard bound rather than a hint: the detector must not allocate
/// per bar, and an unbounded book on a 20-million-bar scan would grow without
/// limit on a trending pair.
#[derive(Debug, Clone)]
pub struct ZoneBook {
    capacity: usize,
    max_age: usize,
    zones: VecDeque<Zone>,
}

impl ZoneBook {
    pub fn new(capacity: usize, max_age: usize) -> Self {
        assert!(capacity > 0, "zone book needs room for at least one zone");
        ZoneBook { capacity, max_age, zones: VecDeque::with_capacity(capacity) }
    }

    /// Adds a zone, evicting the oldest if the book is full.
    pub fn insert(&mut self, zone: Zone) {
        if self.zones.len() == self.capacity {
            self.zones.pop_front();
        }
        self.zones.push_back(zone);
    }

    /// Drops zones older than `max_age`.
    pub fn expire(&mut self, index: usize) {
        let max_age = self.max_age;
        self.zones
            .retain(|z| index.saturating_sub(z.created_index) <= max_age);
    }

    /// Drops zones this close has traded decisively beyond.
    pub fn invalidate(&mut self, close: f64) {
        self.zones.retain(|z| !z.is_violated_by(close));
    }

    /// Removes and returns the oldest zone in `direction` that this bar trades
    /// into. Zones are one-shot, so returning it also consumes it.
    ///
    /// A zone created on this same bar is not eligible: the bar that created it
    /// is the impulse away from it, and counting that as a touch would enter on
    /// the move the zone was drawn from.
    pub fn take_touched(
        &mut self,
        direction: Direction,
        index: usize,
        high: f64,
        low: f64,
    ) -> Option<Zone> {
        let position = self.zones.iter().position(|z| {
            z.direction == direction && z.created_index < index && z.is_touched_by(high, low)
        })?;
        self.zones.remove(position)
    }

    pub fn len(&self) -> usize {
        self.zones.len()
    }

    pub fn is_empty(&self) -> bool {
        self.zones.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Zone> {
        self.zones.iter()
    }

    pub fn reset(&mut self) {
        self.zones.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pushes `(high, low)` pairs from bar 0 upward.
    fn feed(tracker: &mut SwingTracker, bars: &[(f64, f64)]) {
        for (i, &(h, l)) in bars.iter().enumerate() {
            tracker.push(i, h, l);
        }
    }

    #[test]
    fn confirms_a_swing_high_at_the_middle_bar() {
        let mut tracker = SwingTracker::new(2);
        // Peak at index 2, two lower bars either side.
        feed(
            &mut tracker,
            &[(1.0, 0.5), (1.1, 0.6), (1.5, 0.7), (1.2, 0.6), (1.05, 0.55)],
        );

        let high = tracker.high().expect("swing high should have confirmed");
        assert_eq!(high.index, 2);
        assert_eq!(high.price, 1.5);
    }

    #[test]
    fn does_not_confirm_before_the_right_hand_bars_close() {
        let mut tracker = SwingTracker::new(2);
        // The peak is there, but only one bar has closed after it.
        feed(&mut tracker, &[(1.0, 0.5), (1.1, 0.6), (1.5, 0.7), (1.2, 0.6)]);

        assert!(
            tracker.high().is_none(),
            "a swing must not be visible until `lookback` bars have closed after it"
        );
    }

    #[test]
    fn a_flat_top_confirms_nothing() {
        let mut tracker = SwingTracker::new(2);
        // Two bars share the high, so neither is strictly the extreme. Without
        // this, one level would break structure twice.
        feed(
            &mut tracker,
            &[(1.0, 0.5), (1.5, 0.6), (1.5, 0.7), (1.2, 0.6), (1.05, 0.55)],
        );

        assert!(tracker.high().is_none());
    }

    #[test]
    fn an_engulfing_bar_is_both_a_high_and_a_low() {
        let mut tracker = SwingTracker::new(2);
        feed(
            &mut tracker,
            &[(1.0, 0.5), (1.1, 0.6), (1.5, 0.1), (1.2, 0.6), (1.05, 0.55)],
        );

        assert_eq!(tracker.high().unwrap().index, 2);
        assert_eq!(tracker.low().unwrap().index, 2);
    }

    #[test]
    fn consuming_a_swing_clears_it() {
        let mut tracker = SwingTracker::new(2);
        feed(
            &mut tracker,
            &[(1.0, 0.5), (1.1, 0.6), (1.5, 0.7), (1.2, 0.6), (1.05, 0.55)],
        );

        assert!(tracker.high().is_some());
        tracker.consume_high();
        assert!(tracker.high().is_none(), "a broken level must not break again");
    }

    #[test]
    fn reset_forgets_everything() {
        let mut tracker = SwingTracker::new(2);
        feed(
            &mut tracker,
            &[(1.0, 0.5), (1.1, 0.6), (1.5, 0.7), (1.2, 0.6), (1.05, 0.55)],
        );
        tracker.reset();

        assert!(tracker.high().is_none());
        assert!(tracker.low().is_none());
    }

    fn long_zone(created_index: usize) -> Zone {
        Zone {
            direction: Direction::Long,
            high: 1.1030,
            low: 1.1010,
            created_index,
            bos_price: 1.1050,
            fvg_present: false,
        }
    }

    #[test]
    fn a_bar_trading_into_the_near_edge_takes_the_zone() {
        let mut book = ZoneBook::new(4, 50);
        book.insert(long_zone(10));

        let taken = book.take_touched(Direction::Long, 12, 1.1040, 1.1025);
        assert!(taken.is_some());
        assert!(book.is_empty(), "a zone fires once");
    }

    #[test]
    fn a_zone_is_not_touchable_on_the_bar_that_created_it() {
        let mut book = ZoneBook::new(4, 50);
        book.insert(long_zone(10));

        // That bar is the impulse away from the zone; treating it as a touch
        // would enter on the very move the zone was drawn from.
        assert!(book.take_touched(Direction::Long, 10, 1.1040, 1.1000).is_none());
        assert_eq!(book.len(), 1);
    }

    #[test]
    fn a_counter_trend_zone_is_not_eligible() {
        let mut book = ZoneBook::new(4, 50);
        book.insert(long_zone(10));

        assert!(book.take_touched(Direction::Short, 12, 1.1040, 1.1025).is_none());
    }

    #[test]
    fn a_close_beyond_the_far_edge_invalidates() {
        let mut book = ZoneBook::new(4, 50);
        book.insert(long_zone(10));

        book.invalidate(1.1005);
        assert!(book.is_empty(), "the zone did not hold");
    }

    #[test]
    fn a_close_inside_the_zone_does_not_invalidate() {
        let mut book = ZoneBook::new(4, 50);
        book.insert(long_zone(10));

        book.invalidate(1.1020);
        assert_eq!(book.len(), 1);
    }

    #[test]
    fn zones_expire_on_age() {
        let mut book = ZoneBook::new(4, 50);
        book.insert(long_zone(10));

        book.expire(60);
        assert_eq!(book.len(), 1, "exactly at max_age is still live");

        book.expire(61);
        assert!(book.is_empty());
    }

    #[test]
    fn the_book_evicts_the_oldest_when_full() {
        let mut book = ZoneBook::new(2, 50);
        book.insert(long_zone(1));
        book.insert(long_zone(2));
        book.insert(long_zone(3));

        assert_eq!(book.len(), 2, "capacity is a hard bound, not a hint");
        let oldest = book.iter().next().unwrap();
        assert_eq!(oldest.created_index, 2);
    }

    #[test]
    fn edges_follow_the_trade_direction() {
        let long = long_zone(1);
        assert_eq!(long.near_edge(), 1.1030);
        assert_eq!(long.far_edge(), 1.1010);

        let short = Zone { direction: Direction::Short, ..long };
        assert_eq!(short.near_edge(), 1.1010);
        assert_eq!(short.far_edge(), 1.1030);
    }
}
