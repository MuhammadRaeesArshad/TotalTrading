//! Per-symbol simulation parameters.
//!
//! Point size and point value are properties of the instrument, not of the
//! request. A 3-digit JPY cross and a 5-digit major differ by a factor of a
//! hundred in point size — read that from the wrong place and every position
//! on the account is mis-sized by two orders of magnitude.
//!
//! These defaults are a reasonable starting point for a standard-lot USD
//! account. They are *defaults*, not truth: the real values belong to the
//! broker, and `api-gateway` already stores them per symbol when an account
//! connects. Wiring this to read that collection is the honest fix.

use engine_core::SimConfig;

/// The instrument's family, which is what decides how it is priced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A 5-decimal currency pair.
    Fx,
    /// Quoted to 3 decimals, so a point is a hundred times an FX point.
    JpyQuoted,
    /// Spot gold: two decimals, and a lot is 100 ounces rather than 100,000
    /// units of currency. Treating it as FX makes every position a thousand
    /// times the size it should be.
    Gold,
}

fn kind_of(symbol: &str) -> Kind {
    let core: String = symbol
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();

    if core.starts_with("XAU") {
        return Kind::Gold;
    }
    if core.len() >= 6 && &core[3..6] == "JPY" {
        return Kind::JpyQuoted;
    }
    Kind::Fx
}

pub fn default_sim_for(symbol: &str, base: &SimConfig) -> SimConfig {
    // Value of one point on one standard lot, in account currency. For a USD
    // account this is exact on the USD-quoted majors and an approximation on
    // crosses, which vary with the cross rate.
    let (point_size, point_value_per_lot) = match kind_of(symbol) {
        Kind::Fx => (0.00001, 1.0),
        Kind::JpyQuoted => (0.001, 0.67),
        // 100 ounces a lot, quoted to two decimals: a 0.01 move is $1 a lot.
        Kind::Gold => (0.01, 1.0),
    };

    SimConfig { point_size, point_value_per_lot, ..base.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_jpy_quotes_through_broker_suffixes() {
        assert_eq!(kind_of("USDJPY"), Kind::JpyQuoted);
        assert_eq!(kind_of("GBPJPY.r"), Kind::JpyQuoted);
        assert_eq!(kind_of("eurjpy"), Kind::JpyQuoted);
        assert_eq!(kind_of("EURUSD"), Kind::Fx);
        assert_eq!(kind_of("JPYX"), Kind::Fx);
    }

    /// Gold priced as if it were EURUSD would size every position a thousand
    /// times too large — the stop distance in points is what sizing divides by.
    #[test]
    fn gold_is_not_priced_as_a_currency_pair() {
        let base = SimConfig::default();
        let gold = default_sim_for("XAUUSD", &base);
        let major = default_sim_for("EURUSD", &base);
        assert_eq!(gold.point_size, 0.01);
        assert!((gold.point_size / major.point_size - 1_000.0).abs() < 1e-6);

        // Broker suffixes must not hide it.
        assert_eq!(default_sim_for("XAUUSD.r", &base).point_size, 0.01);
        assert_eq!(kind_of("xauusdm"), Kind::Gold);
    }

    #[test]
    fn jpy_pairs_get_a_hundred_times_the_point_size() {
        let base = SimConfig::default();
        let major = default_sim_for("EURUSD", &base);
        let cross = default_sim_for("USDJPY", &base);
        assert!((cross.point_size / major.point_size - 100.0).abs() < 1e-9);
    }
}
