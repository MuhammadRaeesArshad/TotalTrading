//! Where the strategy plugs in — and, deliberately, where it is still absent.
//!
//! The rules are not written here, and no placeholder stands in for them. The
//! strategy definition is still being redefined, and a guessed rule set would
//! propagate into the live scanner too, giving two implementations of
//! something nobody has agreed on.
//!
//! So the engine is complete and the rules are a hole with a shape. When the
//! definition lands, implement [`Detector`] and register it — nothing else in
//! this crate changes.
//!
//! # Contract
//!
//! - `on_bar` is called once per closed bar, in order, never re-entered.
//! - It may only read through [`BarCtx`], which cannot reach a future bar.
//! - It carries its own rolling state and allocates nothing per bar. One
//!   instance per (symbol, timeframe) task, so `&mut self` is uncontended.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::engine::window::BarCtx;
use crate::error::{CoreError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Long,
    Short,
}

impl Direction {
    /// +1 for long, -1 for short. Lets P&L and stop maths stay sign-agnostic.
    #[inline]
    pub const fn sign(self) -> f64 {
        match self {
            Direction::Long => 1.0,
            Direction::Short => -1.0,
        }
    }
}

/// A setup a detector found. Prices are absolute, not distances, so the
/// simulator never has to know how the detector derived them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    pub bar_index: usize,
    pub time: i64,
    pub direction: Direction,
    /// Where the detector wants in. The simulator decides whether that fill is
    /// actually reachable on the next bar.
    pub entry: f64,
    pub stop_loss: f64,
    pub take_profit: Option<f64>,
    /// Bars after which an untriggered setup is abandoned. `None` never expires.
    pub expires_after: Option<usize>,
    /// Whatever the rules computed — zone bounds, confluence flags, indicator
    /// readings. Carried through to Mongo so a trade can be traced back to the
    /// state that produced it, and handed to `ai-analysis` as the structured
    /// payload it summarises.
    #[serde(default)]
    pub detail: HashMap<String, f64>,
}

impl Signal {
    /// Distance from entry to stop, in price. Position sizing divides by this,
    /// so a zero-width stop has to be caught before it reaches the simulator.
    #[inline]
    pub fn risk_distance(&self) -> f64 {
        (self.entry - self.stop_loss).abs()
    }

    pub fn is_coherent(&self) -> bool {
        if !self.entry.is_finite() || !self.stop_loss.is_finite() {
            return false;
        }
        if self.risk_distance() <= f64::EPSILON {
            return false;
        }
        // The stop has to sit on the losing side of entry.
        let stop_ok = match self.direction {
            Direction::Long => self.stop_loss < self.entry,
            Direction::Short => self.stop_loss > self.entry,
        };
        let target_ok = match (self.direction, self.take_profit) {
            (_, None) => true,
            (Direction::Long, Some(tp)) => tp > self.entry,
            (Direction::Short, Some(tp)) => tp < self.entry,
        };
        stop_ok && target_ok
    }
}

/// Collects signals without allocating per bar. Reused across the whole scan.
#[derive(Debug, Default)]
pub struct SignalSink {
    signals: Vec<Signal>,
}

impl SignalSink {
    pub fn with_capacity(n: usize) -> Self {
        SignalSink { signals: Vec::with_capacity(n) }
    }

    #[inline]
    pub fn emit(&mut self, signal: Signal) {
        self.signals.push(signal);
    }

    pub fn drain(&mut self) -> std::vec::Drain<'_, Signal> {
        self.signals.drain(..)
    }

    pub fn as_slice(&self) -> &[Signal] {
        &self.signals
    }

    pub fn clear(&mut self) {
        self.signals.clear();
    }

    pub fn len(&self) -> usize {
        self.signals.len()
    }

    pub fn is_empty(&self) -> bool {
        self.signals.is_empty()
    }
}

/// The rules, whatever they turn out to be.
pub trait Detector: Send {
    fn name(&self) -> &str;

    /// Bars of history needed before output is trustworthy. The runner starts
    /// the scan this far before the requested `from` date, so the first
    /// in-range bar is evaluated with warm indicators rather than skipped.
    fn warmup(&self) -> usize {
        0
    }

    fn on_bar(&mut self, ctx: &BarCtx<'_>, out: &mut SignalSink);

    /// Called before each (symbol, timeframe) task so one instance can be
    /// reused across pairs without carrying state between them.
    fn reset(&mut self) {}
}

/// Builds a fresh detector per parallel task. Detectors are `&mut` and stateful,
/// so they cannot be shared across rayon workers — each worker gets its own.
pub trait DetectorFactory: Send + Sync {
    fn name(&self) -> &str;
    fn build(&self) -> Box<dyn Detector>;
}

/// Stands in until the rules exist. It emits nothing, and the runner refuses
/// to start with it rather than reporting a clean zero-trade run that looks
/// like a working backtest of a strategy that never fires.
pub struct NoDetector;

impl Detector for NoDetector {
    fn name(&self) -> &str {
        "none"
    }
    fn on_bar(&mut self, _ctx: &BarCtx<'_>, _out: &mut SignalSink) {}
}

impl DetectorFactory for NoDetector {
    fn name(&self) -> &str {
        "none"
    }
    fn build(&self) -> Box<dyn Detector> {
        Box::new(NoDetector)
    }
}

/// Maps a strategy's detector name to its implementation.
#[derive(Default)]
pub struct DetectorRegistry {
    factories: HashMap<String, Box<dyn DetectorFactory>>,
}

impl DetectorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, factory: Box<dyn DetectorFactory>) -> &mut Self {
        self.factories.insert(factory.name().to_string(), factory);
        self
    }

    pub fn get(&self, name: &str) -> Result<&dyn DetectorFactory> {
        self.factories
            .get(name)
            .map(|b| b.as_ref())
            .ok_or(CoreError::NoDetector)
    }

    pub fn names(&self) -> Vec<&str> {
        self.factories.keys().map(String::as_str).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.factories.is_empty()
    }
}
