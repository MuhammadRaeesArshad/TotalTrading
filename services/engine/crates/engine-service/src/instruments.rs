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

/// True for symbols quoted in JPY, which brokers price to 3 decimals.
fn is_jpy_quoted(symbol: &str) -> bool {
    let core: String = symbol
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();
    core.len() >= 6 && &core[3..6] == "JPY"
}

pub fn default_sim_for(symbol: &str, base: &SimConfig) -> SimConfig {
    let jpy = is_jpy_quoted(symbol);

    SimConfig {
        point_size: if jpy { 0.001 } else { 0.00001 },
        // Value of one point on one standard lot, in account currency. For a
        // USD account this is exact on the USD-quoted majors and an
        // approximation on crosses, which vary with the cross rate.
        point_value_per_lot: if jpy { 0.67 } else { 1.0 },
        ..base.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_jpy_quotes_through_broker_suffixes() {
        assert!(is_jpy_quoted("USDJPY"));
        assert!(is_jpy_quoted("GBPJPY.r"));
        assert!(is_jpy_quoted("eurjpy"));
        assert!(!is_jpy_quoted("EURUSD"));
        assert!(!is_jpy_quoted("JPYX"));
    }

    #[test]
    fn jpy_pairs_get_a_hundred_times_the_point_size() {
        let base = SimConfig::default();
        let major = default_sim_for("EURUSD", &base);
        let cross = default_sim_for("USDJPY", &base);
        assert!((cross.point_size / major.point_size - 100.0).abs() < 1e-9);
    }
}
