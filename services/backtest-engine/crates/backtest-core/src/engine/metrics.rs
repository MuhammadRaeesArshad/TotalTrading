//! Streaming performance metrics.
//!
//! Single pass, constant memory apart from the equity curve itself. Nothing
//! here sorts or revisits the trade log, so cost stays linear in trade count
//! even across a portfolio-wide run.

use serde::{Deserialize, Serialize};

use crate::engine::sim::Trade;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EquityPoint {
    pub t: i64,
    pub equity: f64,
    pub drawdown: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metrics {
    pub total_trades: usize,
    pub wins: usize,
    pub losses: usize,
    pub win_rate: f64,
    pub net_profit: f64,
    pub gross_profit: f64,
    pub gross_loss: f64,
    pub profit_factor: f64,
    /// Average net result per trade, in account currency.
    pub expectancy: f64,
    /// Average result per trade in R. Comparable across pairs and account sizes.
    pub expectancy_r: f64,
    pub max_drawdown: f64,
    pub max_drawdown_pct: f64,
    pub sharpe: f64,
    pub avg_win: f64,
    pub avg_loss: f64,
    pub longest_losing_streak: usize,
    pub longest_winning_streak: usize,
    pub final_equity: f64,
    /// Trades whose exit was decided by the intrabar policy rather than by the
    /// data. A high share here means the headline number rests on assumption —
    /// worth surfacing next to the result, not burying.
    pub ambiguous_exits: usize,
}

/// Accumulates metrics as trades close.
#[derive(Debug)]
pub struct MetricsAccumulator {
    initial_balance: f64,
    equity: f64,
    peak: f64,
    max_drawdown: f64,
    max_drawdown_pct: f64,

    total: usize,
    wins: usize,
    losses: usize,
    gross_profit: f64,
    gross_loss: f64,
    sum_r: f64,
    ambiguous: usize,

    losing_streak: usize,
    longest_losing_streak: usize,
    winning_streak: usize,
    longest_winning_streak: usize,

    // Running moments of per-trade returns, for Sharpe.
    return_count: usize,
    return_mean: f64,
    return_m2: f64,

    curve: Vec<EquityPoint>,
    /// Curve points are sampled rather than emitted per trade — a million-trade
    /// run does not need a million points to draw, and the document has to fit
    /// in Mongo.
    sample_every: usize,
}

impl MetricsAccumulator {
    pub fn new(initial_balance: f64, expected_trades: usize) -> Self {
        // Aim for at most ~4000 points; that is more than any chart resolves.
        let sample_every = (expected_trades / 4_000).max(1);

        MetricsAccumulator {
            initial_balance,
            equity: initial_balance,
            peak: initial_balance,
            max_drawdown: 0.0,
            max_drawdown_pct: 0.0,
            total: 0,
            wins: 0,
            losses: 0,
            gross_profit: 0.0,
            gross_loss: 0.0,
            sum_r: 0.0,
            ambiguous: 0,
            losing_streak: 0,
            longest_losing_streak: 0,
            winning_streak: 0,
            longest_winning_streak: 0,
            return_count: 0,
            return_mean: 0.0,
            return_m2: 0.0,
            curve: Vec::with_capacity(4_096),
            sample_every,
        }
    }

    /// Trades must arrive in exit-time order — equity is path-dependent, and
    /// max drawdown computed over a shuffled log is meaningless.
    pub fn record(&mut self, trade: &Trade) {
        let before = self.equity;
        self.equity += trade.net_profit;
        self.total += 1;
        self.sum_r += trade.r_multiple;

        if trade.ambiguous_exit {
            self.ambiguous += 1;
        }

        if trade.net_profit >= 0.0 {
            self.wins += 1;
            self.gross_profit += trade.net_profit;
            self.winning_streak += 1;
            self.losing_streak = 0;
            self.longest_winning_streak = self.longest_winning_streak.max(self.winning_streak);
        } else {
            self.losses += 1;
            self.gross_loss += -trade.net_profit;
            self.losing_streak += 1;
            self.winning_streak = 0;
            self.longest_losing_streak = self.longest_losing_streak.max(self.losing_streak);
        }

        // Welford, on per-trade fractional return. Valid here because the
        // sample only grows — nothing is ever removed.
        if before > 0.0 {
            let r = trade.net_profit / before;
            self.return_count += 1;
            let delta = r - self.return_mean;
            self.return_mean += delta / self.return_count as f64;
            self.return_m2 += delta * (r - self.return_mean);
        }

        if self.equity > self.peak {
            self.peak = self.equity;
        }
        let drawdown = self.peak - self.equity;
        if drawdown > self.max_drawdown {
            self.max_drawdown = drawdown;
            self.max_drawdown_pct = if self.peak > 0.0 {
                drawdown / self.peak * 100.0
            } else {
                0.0
            };
        }

        // Always keep the first and last points, plus every nth in between.
        if self.total == 1 || self.total % self.sample_every == 0 {
            self.curve.push(EquityPoint {
                t: trade.exit_time,
                equity: self.equity,
                drawdown,
            });
        }
    }

    pub fn finish(mut self) -> (Metrics, Vec<EquityPoint>) {
        if let Some(&last) = self.curve.last() {
            if last.equity != self.equity {
                self.curve.push(EquityPoint {
                    t: last.t,
                    equity: self.equity,
                    drawdown: self.peak - self.equity,
                });
            }
        }

        let total = self.total as f64;

        let profit_factor = if self.gross_loss > 0.0 {
            self.gross_profit / self.gross_loss
        } else if self.gross_profit > 0.0 {
            // No losing trades at all. Infinity is not a useful number to store
            // or render, and it usually means too small a sample.
            f64::INFINITY
        } else {
            0.0
        };

        let std_dev = if self.return_count > 1 {
            (self.return_m2 / (self.return_count - 1) as f64).sqrt()
        } else {
            0.0
        };

        // Per-trade Sharpe, not annualised: annualising needs a trade frequency
        // this crate has no business assuming. Compare runs to each other.
        let sharpe = if std_dev > 0.0 {
            self.return_mean / std_dev
        } else {
            0.0
        };

        let metrics = Metrics {
            total_trades: self.total,
            wins: self.wins,
            losses: self.losses,
            win_rate: if self.total > 0 { self.wins as f64 / total * 100.0 } else { 0.0 },
            net_profit: self.equity - self.initial_balance,
            gross_profit: self.gross_profit,
            gross_loss: self.gross_loss,
            profit_factor,
            expectancy: if self.total > 0 {
                (self.equity - self.initial_balance) / total
            } else {
                0.0
            },
            expectancy_r: if self.total > 0 { self.sum_r / total } else { 0.0 },
            max_drawdown: self.max_drawdown,
            max_drawdown_pct: self.max_drawdown_pct,
            sharpe,
            avg_win: if self.wins > 0 { self.gross_profit / self.wins as f64 } else { 0.0 },
            avg_loss: if self.losses > 0 { self.gross_loss / self.losses as f64 } else { 0.0 },
            longest_losing_streak: self.longest_losing_streak,
            longest_winning_streak: self.longest_winning_streak,
            final_equity: self.equity,
            ambiguous_exits: self.ambiguous,
        };

        (metrics, self.curve)
    }

    #[inline]
    pub fn equity(&self) -> f64 {
        self.equity
    }
}
