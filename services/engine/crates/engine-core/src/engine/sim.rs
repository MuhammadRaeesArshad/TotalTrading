//! Order simulation: turning signals into fills, and fills into trades.
//!
//! The honest part of a backtester. Detection decides where you would want to
//! trade; this decides what you would actually have got, and most of the gap
//! between a backtest and a live account lives here.

use std::collections::HashMap;

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
    /// Percent risked per trade, sized off the stop distance. What it is a
    /// percent *of* is `sizing`.
    pub risk_percent: f64,
    pub sizing: SizingMode,
    /// Round-turn commission per lot, in account currency.
    pub commission_per_lot: f64,
    /// Overnight financing for a long, in points per lot per night. Negative
    /// is a charge, which is the usual direction. The broker's own figure —
    /// see `mt5-connector`'s `swap_long`, which is where it comes from.
    pub swap_long_points: f64,
    /// The same for a short. Positive on one side of a carry pair.
    pub swap_short_points: f64,
    /// Hour of the rollover charge, UTC. 22:00 is 17:00 New York outside DST,
    /// which is when the spot market rolls.
    pub swap_rollover_hour: i64,
    /// Weekday charged triple, 0 being Sunday. Wednesday for spot FX, because
    /// settlement is two business days out and that night carries the weekend.
    pub swap_triple_weekday: u8,
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
    /// A trade is skipped when its stop sits closer to the fill than this many
    /// times the entry cost (spread plus slippage). Sizing off a stop inside the
    /// spread puts on a huge position whose costs alone are many R; no broker
    /// would accept the stop, and no trader would take the trade.
    pub min_risk_cost_multiple: f64,
}

impl Default for SimConfig {
    fn default() -> Self {
        SimConfig {
            initial_balance: 10_000.0,
            risk_percent: 1.0,
            sizing: SizingMode::Fixed,
            commission_per_lot: 7.0,
            // Zero until the broker's real rates are wired through per symbol.
            // Unlike spread and commission there is no sensible pessimistic
            // guess — swap is positive on one side of some pairs — and
            // inventing one would be worse than reporting none. The UI says
            // when it is zero rather than letting it pass as free.
            swap_long_points: 0.0,
            swap_short_points: 0.0,
            swap_rollover_hour: 22,
            swap_triple_weekday: 3,
            extra_spread_points: 0.0,
            slippage_points: 0.0,
            point_size: 0.00001,
            point_value_per_lot: 1.0,
            volume_min: 0.01,
            volume_max: 100.0,
            volume_step: 0.01,
            intrabar: IntrabarPolicy::Pessimistic,
            // The user's choice: up to three concurrent positions per pair. At the
            // default 1% risk that is up to 3% of equity exposed on one symbol.
            max_open_per_symbol: 3,
            min_risk_cost_multiple: 2.0,
        }
    }
}

/// What `risk_percent` is a percent of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SizingMode {
    /// The starting balance, every trade, for the whole run. The account
    /// cannot run out, so every signal the detector finds is actually tested.
    ///
    /// This is the default because the alternative silently stops answering:
    /// once a compounding account reaches zero, every later position rounds
    /// below the broker's minimum and is skipped, while the metrics go on
    /// reporting as though the run continued. A sweep then measures how fast
    /// each setting killed the account rather than what the setting does.
    ///
    /// Money is linear in R here, so R is the figure to read.
    #[default]
    Fixed,
    /// Equity as it stands: profits compound, a loss shrinks the next
    /// position, and the account can be wiped out. What a real account does,
    /// and the right choice for asking whether a size is survivable.
    Compound,
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
    /// Overnight financing paid over the life of the trade. Negative is a
    /// cost. Zero when the broker's rates were not supplied.
    #[serde(default)]
    pub swap: f64,
    pub net_profit: f64,
    /// Result in multiples of the risk taken. The only cross-pair comparable
    /// number a trade log has.
    pub r_multiple: f64,
    /// True when stop and target both sat inside the exit bar, so the outcome
    /// was decided by [`IntrabarPolicy`] rather than by the data.
    pub ambiguous_exit: bool,
    pub bars_held: usize,
    /// Furthest the trade went against the position before exit, in R. Always
    /// zero or positive. A stopped-out trade reads about 1.0.
    #[serde(default)]
    pub mae_r: f64,
    /// Furthest the trade went in its favour before exit, in R. A loser with a
    /// high value here was right about direction and wrong about the exit.
    #[serde(default)]
    pub mfe_r: f64,
    /// The signal's `detail` map, carried through so a trade can be traced back
    /// to the state that produced it — zone bounds, the broken level, flags.
    #[serde(default)]
    pub detail: HashMap<String, f64>,
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
    /// Furthest price has moved against the position, as a distance from entry.
    pub max_adverse: f64,
    /// Furthest price has moved in the position's favour, as a distance from entry.
    pub max_favorable: f64,
    pub detail: HashMap<String, f64>,
}

impl OpenPosition {
    /// Folds one bar's range into the excursions.
    ///
    /// Call it only for bars the position survived. Within the exit bar the
    /// order of high and low is unknown, so its extremes cannot be attributed
    /// to the time the position was still open — `close_position` counts only
    /// the exit price from that bar.
    #[inline]
    pub fn track_excursion(&mut self, bar: &BarSlice) {
        let (favorable, adverse) = match self.direction {
            Direction::Long => (bar.high - self.entry_price, self.entry_price - bar.low),
            Direction::Short => (self.entry_price - bar.low, bar.high - self.entry_price),
        };
        self.max_favorable = self.max_favorable.max(favorable);
        self.max_adverse = self.max_adverse.max(adverse);
    }
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
    /// Lot size that puts `risk_percent` of `equity` at the stop, rounded down
    /// to the broker's volume step. Rounding *down* matters: rounding up
    /// quietly exceeds the risk limit on every trade.
    ///
    /// `equity` is whatever `sizing` says it is; this does not decide.
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
    pub(crate) fn cost_offset(&self, bar_spread_points: u16) -> f64 {
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

    // Financing for every night the position stayed open. Costs nothing on a
    // trade that opened and closed the same day, and dominates one held for
    // weeks — which is exactly why leaving it out flatters slow strategies.
    let rate = match position.direction {
        Direction::Long => config.swap_long_points,
        Direction::Short => config.swap_short_points,
    };
    let swap = swap_nights(
        position.entry_time,
        bar.time,
        config.swap_rollover_hour,
        config.swap_triple_weekday,
    ) * rate * config.point_value_per_lot * position.volume;

    let net = gross - position.commission + swap;

    // R is measured against the risk taken, not the nominal stop distance, so
    // slippage on entry shows up in the number.
    let risk_amount =
        (position.risk_distance / config.point_size) * config.point_value_per_lot * position.volume;
    let r_multiple = if risk_amount > 0.0 { net / risk_amount } else { 0.0 };

    // The exit price is the last thing the position saw, so it counts toward
    // both excursions; the rest of the exit bar does not (see track_excursion).
    let (mae_r, mfe_r) = if position.risk_distance > 0.0 {
        let adverse = position.max_adverse.max(-moved).max(0.0);
        let favorable = position.max_favorable.max(moved).max(0.0);
        (adverse / position.risk_distance, favorable / position.risk_distance)
    } else {
        (0.0, 0.0)
    };

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
        swap,
        net_profit: net,
        r_multiple,
        ambiguous_exit: ambiguous,
        bars_held: bar.index.saturating_sub(position.entry_index),
        mae_r,
        mfe_r,
        detail: position.detail.clone(),
    }
}

#[inline]
fn round_to(value: f64, step: f64) -> f64 {
    if step <= 0.0 {
        return value;
    }
    (value / step).round() * step
}

/// Rollover instants a position was open across, weighted.
///
/// A position held overnight is financed, and that charge is the cost most
/// often left out of a backtest — it does not show on any bar, and a strategy
/// holding for days can be paying more in swap than in spread.
///
/// Counting rules, which are the broker's and not ours:
/// - A charge lands at the rollover hour, once per night, for each night the
///   position is still open. Opening and closing inside one day costs nothing.
/// - **Wednesday pays triple.** Spot settles two business days out, so the
///   Wednesday rollover carries the weekend's financing with it.
/// - Saturday and Sunday have no rollover, because the market is shut. The
///   Wednesday triple is what pays for those days.
///
/// Returns the number of nights, weighted — 3.0 for one Wednesday night.
pub fn swap_nights(entry_ts: i64, exit_ts: i64, rollover_hour: i64, triple_weekday: u8) -> f64 {
    if exit_ts <= entry_ts {
        return 0.0;
    }

    const DAY: i64 = 86_400;
    let first_day = entry_ts.div_euclid(DAY);
    let last_day = exit_ts.div_euclid(DAY);

    let mut nights = 0.0;
    for day in first_day..=last_day {
        let instant = day * DAY + rollover_hour * 3_600;
        // Strictly after entry: a position opened at the rollover instant has
        // not been held overnight. Up to and including exit.
        if instant <= entry_ts || instant > exit_ts {
            continue;
        }
        match weekday(day) {
            // Shut. The Wednesday triple covers these.
            0 | 6 => continue,
            w if w == triple_weekday => nights += 3.0,
            _ => nights += 1.0,
        }
    }
    nights
}

/// Day of the week for a day index since the epoch. 0 is Sunday.
///
/// 1 January 1970 was a Thursday, which is 4 counting from Sunday.
#[inline]
fn weekday(days_since_epoch: i64) -> u8 {
    (days_since_epoch + 4).rem_euclid(7) as u8
}

#[cfg(test)]
mod swap_tests {
    use super::{swap_nights, weekday};

    /// 1 Jan 1970 was a Thursday; 4 Jan 1970 a Sunday.
    #[test]
    fn the_epoch_was_a_thursday() {
        assert_eq!(weekday(0), 4);
        assert_eq!(weekday(3), 0);
        assert_eq!(weekday(2), 6);
    }

    // Monday 6 Jan 2025, 00:00 UTC.
    const MON: i64 = 1_736_121_600;
    const DAY: i64 = 86_400;
    const HOUR: i64 = 3_600;

    #[test]
    fn a_trade_closed_the_same_day_is_never_financed() {
        assert_eq!(swap_nights(MON + 8 * HOUR, MON + 16 * HOUR, 22, 3), 0.0);
    }

    #[test]
    fn one_night_held_is_one_charge() {
        // Monday morning to Tuesday morning crosses Monday's rollover once.
        assert_eq!(swap_nights(MON + 8 * HOUR, MON + DAY + 8 * HOUR, 22, 3), 1.0);
    }

    #[test]
    fn opening_exactly_at_rollover_has_not_been_held_overnight() {
        assert_eq!(swap_nights(MON + 22 * HOUR, MON + 23 * HOUR, 22, 3), 0.0);
    }

    #[test]
    fn wednesday_costs_three_nights() {
        // Wednesday 8 Jan is MON + 2 days. Hold across its rollover only.
        let wed_morning = MON + 2 * DAY + 8 * HOUR;
        assert_eq!(swap_nights(wed_morning, wed_morning + DAY, 22, 3), 3.0);
    }

    #[test]
    fn a_weekend_is_not_charged_twice() {
        // Friday morning to Monday morning: Friday's rollover only, because
        // Saturday and Sunday have none. The weekend was paid on Wednesday.
        let fri = MON + 4 * DAY + 8 * HOUR;
        assert_eq!(swap_nights(fri, fri + 3 * DAY, 22, 3), 1.0);
    }

    #[test]
    fn a_full_week_costs_seven_nights_not_five() {
        // Mon 08:00 to the following Mon 08:00: Mon, Tue, Thu, Fri at 1 and
        // Wednesday at 3 — seven, which is the week's real financing.
        assert_eq!(swap_nights(MON + 8 * HOUR, MON + 7 * DAY + 8 * HOUR, 22, 3), 7.0);
    }

    #[test]
    fn a_backwards_or_instant_trade_is_free() {
        assert_eq!(swap_nights(MON, MON, 22, 3), 0.0);
        assert_eq!(swap_nights(MON + DAY, MON, 22, 3), 0.0);
    }
}
