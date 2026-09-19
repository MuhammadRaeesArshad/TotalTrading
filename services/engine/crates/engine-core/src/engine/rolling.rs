//! Incremental window statistics.
//!
//! Every type here is O(1) per bar and allocation-free after construction.
//! That matters more than it sounds: a rolling 200-bar high recomputed naively
//! is O(n·w), which over 20 million bars is four billion comparisons for one
//! indicator on one pair. The monotonic deque below makes it O(n) — amortised
//! one push and one pop per bar, regardless of window size.

use std::collections::VecDeque;

/// Rolling extreme (max or min) over a fixed window, in amortised O(1).
///
/// Holds a deque of indices whose values are monotonic. When a new value
/// arrives, everything it dominates is popped from the back — those can never
/// be the extreme again while the new value is in the window. The front is
/// then the answer, and is popped once it falls out of range.
///
/// Each index is pushed once and popped once across the whole scan, so the
/// total work is linear no matter how wide the window.
#[derive(Debug, Clone)]
pub struct MonotonicWindow {
    window: usize,
    /// (index, value), monotonically decreasing for Max, increasing for Min.
    deque: VecDeque<(usize, f64)>,
    kind: Extreme,
    seen: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Extreme {
    Max,
    Min,
}

impl MonotonicWindow {
    pub fn new(window: usize, kind: Extreme) -> Self {
        assert!(window > 0, "window must be at least 1 bar");
        MonotonicWindow {
            window,
            deque: VecDeque::with_capacity(window.min(1024)),
            kind,
            seen: 0,
        }
    }

    pub fn max(window: usize) -> Self {
        Self::new(window, Extreme::Max)
    }

    pub fn min(window: usize) -> Self {
        Self::new(window, Extreme::Min)
    }

    #[inline]
    fn dominates(&self, incoming: f64, existing: f64) -> bool {
        match self.kind {
            Extreme::Max => incoming >= existing,
            Extreme::Min => incoming <= existing,
        }
    }

    #[inline]
    pub fn push(&mut self, value: f64) {
        let index = self.seen;
        self.seen += 1;

        while let Some(&(_, back)) = self.deque.back() {
            if self.dominates(value, back) {
                self.deque.pop_back();
            } else {
                break;
            }
        }
        self.deque.push_back((index, value));

        // Evict anything that has aged out of the window.
        let cutoff = index.saturating_sub(self.window - 1);
        while let Some(&(front_index, _)) = self.deque.front() {
            if front_index < cutoff {
                self.deque.pop_front();
            } else {
                break;
            }
        }
    }

    /// Current extreme, or `None` before the first push.
    #[inline]
    pub fn value(&self) -> Option<f64> {
        self.deque.front().map(|&(_, v)| v)
    }

    /// Absolute index of the bar holding the current extreme. Useful for
    /// anchoring a level to the bar that made it.
    #[inline]
    pub fn index(&self) -> Option<usize> {
        self.deque.front().map(|&(i, _)| i)
    }

    #[inline]
    pub fn is_warm(&self) -> bool {
        self.seen >= self.window
    }

    pub fn reset(&mut self) {
        self.deque.clear();
        self.seen = 0;
    }
}

/// Rolling mean and variance over a fixed window, in O(1).
///
/// Uses a ring buffer plus running sums rather than Welford. Welford is the
/// better choice for a *growing* sample, but it has no exact removal step —
/// and a sliding window needs one. Running sums with f64 over a bounded window
/// of price data stay well inside tolerance, and the sums are reset on
/// `reset()` rather than drifting across a whole run.
#[derive(Debug, Clone)]
pub struct RollingStats {
    window: usize,
    buf: Vec<f64>,
    cursor: usize,
    filled: usize,
    sum: f64,
    sum_sq: f64,
}

impl RollingStats {
    pub fn new(window: usize) -> Self {
        assert!(window > 0, "window must be at least 1 bar");
        RollingStats {
            window,
            buf: vec![0.0; window],
            cursor: 0,
            filled: 0,
            sum: 0.0,
            sum_sq: 0.0,
        }
    }

    #[inline]
    pub fn push(&mut self, value: f64) {
        if self.filled == self.window {
            let evicted = self.buf[self.cursor];
            self.sum -= evicted;
            self.sum_sq -= evicted * evicted;
        } else {
            self.filled += 1;
        }

        self.buf[self.cursor] = value;
        self.sum += value;
        self.sum_sq += value * value;
        self.cursor = (self.cursor + 1) % self.window;
    }

    #[inline]
    pub fn mean(&self) -> f64 {
        if self.filled == 0 {
            return f64::NAN;
        }
        self.sum / self.filled as f64
    }

    /// Population variance over the window. Clamped at zero — cancellation in
    /// the running sums can otherwise produce a tiny negative.
    #[inline]
    pub fn variance(&self) -> f64 {
        if self.filled < 2 {
            return f64::NAN;
        }
        let n = self.filled as f64;
        ((self.sum_sq - self.sum * self.sum / n) / n).max(0.0)
    }

    #[inline]
    pub fn std_dev(&self) -> f64 {
        self.variance().sqrt()
    }

    #[inline]
    pub fn is_warm(&self) -> bool {
        self.filled == self.window
    }

    pub fn reset(&mut self) {
        self.buf.fill(0.0);
        self.cursor = 0;
        self.filled = 0;
        self.sum = 0.0;
        self.sum_sq = 0.0;
    }
}

/// Wilder's smoothing — the recursive average behind ATR, RSI and ADX.
///
/// Wilder's is *not* a standard EMA: its factor is `1/period`, where an EMA of
/// the same period uses `2/(period+1)`. Mixing them up puts every ATR-derived
/// stop in the wrong place, so it is its own type here rather than a parameter.
#[derive(Debug, Clone, Copy)]
pub struct Wilder {
    period: usize,
    value: f64,
    seen: usize,
    seed_sum: f64,
}

impl Wilder {
    pub fn new(period: usize) -> Self {
        assert!(period > 0, "period must be at least 1");
        Wilder { period, value: f64::NAN, seen: 0, seed_sum: 0.0 }
    }

    #[inline]
    pub fn push(&mut self, value: f64) {
        self.seen += 1;

        // Seeded with a simple average of the first `period` samples, which is
        // what Wilder specified and what MT5 does.
        if self.seen <= self.period {
            self.seed_sum += value;
            if self.seen == self.period {
                self.value = self.seed_sum / self.period as f64;
            }
            return;
        }

        self.value += (value - self.value) / self.period as f64;
    }

    #[inline]
    pub fn value(&self) -> Option<f64> {
        self.is_warm().then_some(self.value)
    }

    #[inline]
    pub fn is_warm(&self) -> bool {
        self.seen >= self.period
    }

    pub fn reset(&mut self) {
        self.value = f64::NAN;
        self.seen = 0;
        self.seed_sum = 0.0;
    }
}

/// Average True Range. Carries the previous close itself, because true range
/// needs it and threading it through every call site invites bugs.
#[derive(Debug, Clone, Copy)]
pub struct Atr {
    wilder: Wilder,
    prev_close: f64,
    started: bool,
}

impl Atr {
    pub fn new(period: usize) -> Self {
        Atr { wilder: Wilder::new(period), prev_close: f64::NAN, started: false }
    }

    #[inline]
    pub fn push(&mut self, high: f64, low: f64, close: f64) {
        let tr = if self.started {
            let a = high - low;
            let b = (high - self.prev_close).abs();
            let c = (low - self.prev_close).abs();
            a.max(b).max(c)
        } else {
            self.started = true;
            high - low
        };

        self.wilder.push(tr);
        self.prev_close = close;
    }

    #[inline]
    pub fn value(&self) -> Option<f64> {
        self.wilder.value()
    }

    #[inline]
    pub fn is_warm(&self) -> bool {
        self.wilder.is_warm()
    }
}

/// Exponential moving average, the conventional `2/(period+1)` kind.
#[derive(Debug, Clone, Copy)]
pub struct Ema {
    alpha: f64,
    value: f64,
    seen: usize,
    period: usize,
    seed_sum: f64,
}

impl Ema {
    pub fn new(period: usize) -> Self {
        assert!(period > 0, "period must be at least 1");
        Ema {
            alpha: 2.0 / (period as f64 + 1.0),
            value: f64::NAN,
            seen: 0,
            period,
            seed_sum: 0.0,
        }
    }

    #[inline]
    pub fn push(&mut self, value: f64) {
        self.seen += 1;
        if self.seen <= self.period {
            self.seed_sum += value;
            if self.seen == self.period {
                self.value = self.seed_sum / self.period as f64;
            }
            return;
        }
        self.value += self.alpha * (value - self.value);
    }

    #[inline]
    pub fn value(&self) -> Option<f64> {
        (self.seen >= self.period).then_some(self.value)
    }
}
