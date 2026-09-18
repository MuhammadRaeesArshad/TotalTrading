//! Order simulation: turning signals into fills, and fills into trades.
//!
//! The honest part of a backtester. Detection decides where you would want to
//! trade; this decides what you would actually have got, and most of the gap
//! between a backtest and a live account lives here.

use serde::{Deserialize, Serialize};

use crate::engine::detector::{Direction, Signal};

/// What to assume when a bar's range contains both the stop and the target.
///
/// A bar says where price went, not in what order. When both levels sit inside
/// one bar's range, the result is genuinely unknown at this resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IntrabarPolicy {
    /// Assume the stop hit first. The default, and the only one to trust: it
    /// biases every ambiguous bar against the strategy, so a result that
    /// survives it is a floor rather than a hope.
    Pessimistic,
    /// Assume the target hit first. Useful only to bound the optimistic case —
    /// the spread between the two policies measures how much of a result rests
    /// on ambiguous bars.
    Optimistic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimConfig {
    pub initial_balance: f64,
    /// Percent of current equity risked per trade, sized off the stop distance.
    pub risk_percent: f64,
    /// Round-turn commission per lot, in account currency.
    pub commission_per_lot: f64,
    /// Extra spread in points beyond what the bar recorded. Broker spread
    /// widens around news and rollover in ways bar data flattens out.
    pub extra_spread_points: f64,
    /// Worst-case slippage in points on entry and exit.
    pub slippage_points: f64,
    pub point_size: f64,
    /// Account-currency value of one point on one lot.
    pub point_value_per_lot: f64,
    pub volume_min: f64,
    pub volume_max: f64,
    pub volume_step: f64,
    pub intrabar: IntrabarPolicy,
    /// Cap on concurrent open positions per symbol.
    pub max_open_per_symbol: usize,
}

impl Default for SimConfig {
    fn default() -> Self {
        SimConfig {
            initial_balance: 10_000.0,
            risk_percent: 1.0,
            commission_per_lot: 7.0,
            extra_spread_points: 0.0,
            slippage_points: 0.0,
            point_size: 0.00001,
            point_value_per_lot: 1.0,
            volume_min: 0.01,
            volume_max: 100.0,
            volume_step: 0.01,
            intrabar: IntrabarPolicy::Pessimistic,
            max_open_per_symbol: 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    StopLoss,
    TakeProfit,
    /// Still open when the run reached its end date.
    EndOfData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub symbol: String,
    pub direction: Direction,
    pub volume: f64,
    pub entry_time: i64,
    pub entry_price: f64,
    pub entry_index: usize,
    pub exit_time: i64,
    pub exit_price: f64,
    pub exit_index: usize,
    pub stop_loss: f64,
    pub take_profit: Option<f64>,
    pub exit_reason: ExitReason,
    pub gross_profit: f64,
    pub commission: f64,
    pub net_profit: f64,
    /// Result in multiples of the risk taken. The only cross-pair comparable
    /// number a trade log has.
    pub r_multiple: f64,
    /// True when stop and target both sat inside the exit bar, so the outcome
    /// was decided by [`IntrabarPolicy`] rather than by the data.
    pub ambiguous_exit: bool,
    pub bars_held: usize,
}

/// A position in flight.
#[derive(Debug, Clone)]
pub struct OpenPosition {
    pub direction: Direction,
    pub volume: f64,
    pub entry_price: f64,
    pub entry_time: i64,
    pub entry_index: usize,
    pub stop_loss: f64,
    pub take_profit: Option<f64>,
    pub risk_distance: f64,
    pub commission: f64,
    /// Next bar still to be checked for an exit.
    ///
    /// Without this, every pass re-walks the position from its entry bar. A
    /// position held across many signals then gets rescanned once per signal,
    /// turning the exit search quadratic in how long trades are held — which
    /// is exactly the case a long-horizon backtest hits hardest.
    pub scan_cursor: usize,
}

/// A bar, passed to the simulator by value — it is six numbers, and threading
/// six slices through every call reads worse than this does.
#[derive(Debug, Clone, Copy)]
pub struct BarSlice {
    pub index: usize,
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub spread_points: u16,
}

impl SimConfig {
    /// Lot size that puts `risk_percent` of equity at the stop, rounded down to
    /// the broker's volume step. Rounding *down* matters: rounding up quietly
    /// exceeds the risk limit on every trade.
    pub fn position_size(&self, equity: f64, risk_distance: f64) -> Option<f64> {
        if risk_distance <= 0.0 || !risk_distance.is_finite() || equity <= 0.0 {
            return None;
        }

        let risk_amount = equity * self.risk_percent / 100.0;
        let risk_points = risk_distance / self.point_size;
        if risk_points <= 0.0 {
            return None;
        }

        let raw = risk_amount / (risk_points * self.point_value_per_lot);
        let stepped = (raw / self.volume_step).floor() * self.volume_step;
        let clamped = stepped.min(self.volume_max);

        // Below the broker's minimum the trade is not placeable. Skipping it is
        // the truthful outcome; sizing up to the minimum would silently take
        // more risk than configured.
        (clamped >= self.volume_min).then_some(round_to(clamped, self.volume_step))
    }

    /// Half-spread plus slippage, in price, applied against the trade.
    #[inline]
    fn cost_offset(&self, bar_spread_points: u16) -> f64 {
        let spread = bar_spread_points as f64 + self.extra_spread_points;
        (spread + self.slippage_points) * self.point_size
    }

    /// Entry fill on the bar after the signal.
    ///
    /// Filled at that bar's open, moved against the trade by spread and
    /// slippage. Entering at the signal bar's close is the classic way to
    /// manufacture returns that do not exist — the close is only knowable once
    /// the bar is over.
    pub fn fill_entry(&self, signal: &Signal, bar: &BarSlice) -> Option<f64> {
        let offset = self.cost_offset(bar.spread_points);
        let price = match signal.direction {
            Direction::Long => bar.open + offset,
            Direction::Short => bar.open - offset,
        };
        price.is_finite().then_some(price)
    }
}

/// Resolves one open position against one bar.
///
/// Returns the exit price, reason and ambiguity flag, or `None` if the
/// position survives the bar.
pub fn resolve_exit(
    position: &OpenPosition,
    bar: &BarSlice,
    config: &SimConfig,
) -> Option<(f64, ExitReason, bool)> {
    let offset = config.cost_offset(bar.spread_points);

    let (stop_hit, target_hit) = match position.direction {
        Direction::Long => (
            bar.low <= position.stop_loss,
            position.take_profit.is_some_and(|tp| bar.high >= tp),
        ),
        Direction::Short => (
            bar.high >= position.stop_loss,
            position.take_profit.is_some_and(|tp| bar.low <= tp),
        ),
    };

    match (stop_hit, target_hit) {
        (false, false) => None,

        (true, false) => {
            // Stops slip against you, so the fill is worse than the level.
            let price = match position.direction {
                Direction::Long => position.stop_loss - offset,
                Direction::Short => position.stop_loss + offset,
            };
            Some((price, ExitReason::StopLoss, false))
        }

        (false, true) => Some((position.take_profit.unwrap(), ExitReason::TakeProfit, false)),

        // Both inside one bar. The data cannot say which came first.
        (true, true) => match config.intrabar {
            IntrabarPolicy::Pessimistic => {
                let price = match position.direction {
                    Direction::Long => position.stop_loss - offset,
                    Direction::Short => position.stop_loss + offset,
                };
                Some((price, ExitReason::StopLoss, true))
            }
            IntrabarPolicy::Optimistic => {
                Some((position.take_profit.unwrap(), ExitReason::TakeProfit, true))
            }
        },
    }
}

/// Closes a position and computes its P&L.
pub fn close_position(
    symbol: &str,
    position: &OpenPosition,
    bar: &BarSlice,
    exit_price: f64,
    reason: ExitReason,
    ambiguous: bool,
    config: &SimConfig,
) -> Trade {
    let moved = (exit_price - position.entry_price) * position.direction.sign();
    let points = moved / config.point_size;
    let gross = points * config.point_value_per_lot * position.volume;
    let net = gross - position.commission;

    // R is measured against the risk taken, not the nominal stop distance, so
    // slippage on entry shows up in the number.
    let risk_amount =
        (position.risk_distance / config.point_size) * config.point_value_per_lot * position.volume;
    let r_multiple = if risk_amount > 0.0 { net / risk_amount } else { 0.0 };

    Trade {
        symbol: symbol.to_string(),
        direction: position.direction,
        volume: position.volume,
        entry_time: position.entry_time,
        entry_price: position.entry_price,
        entry_index: position.entry_index,
        exit_time: bar.time,
        exit_price,
        exit_index: bar.index,
        stop_loss: position.stop_loss,
        take_profit: position.take_profit,
        exit_reason: reason,
        gross_profit: gross,
        commission: position.commission,
        net_profit: net,
        r_multiple,
        ambiguous_exit: ambiguous,
        bars_held: bar.index.saturating_sub(position.entry_index),
    }
}

#[inline]
fn round_to(value: f64, step: f64) -> f64 {
    if step <= 0.0 {
        return value;
    }
    (value / step).round() * step
}
