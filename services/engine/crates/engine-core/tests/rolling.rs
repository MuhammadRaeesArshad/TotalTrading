//! The rolling primitives are checked against naive recomputation. They exist
//! purely as an optimisation, so "same answer as the obvious implementation"
//! is the entire specification.

use engine_core::engine::rolling::{Atr, Ema, MonotonicWindow, RollingStats, Wilder};

/// Deterministic pseudo-prices. A fixed sequence, so a failure reproduces.
fn series(n: usize) -> Vec<f64> {
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    (0..n)
        .map(|i| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let noise = (state >> 40) as f64 / 16_777_216.0;
            1.0850 + (i as f64 / 97.0).sin() * 0.004 + noise * 0.0008
        })
        .collect()
}

fn naive_max(values: &[f64], end: usize, window: usize) -> f64 {
    let start = (end + 1).saturating_sub(window);
    values[start..=end].iter().copied().fold(f64::MIN, f64::max)
}

fn naive_min(values: &[f64], end: usize, window: usize) -> f64 {
    let start = (end + 1).saturating_sub(window);
    values[start..=end].iter().copied().fold(f64::MAX, f64::min)
}

#[test]
fn monotonic_window_matches_naive_max() {
    let values = series(5_000);
    for window in [1usize, 2, 7, 50, 200, 999] {
        let mut rolling = MonotonicWindow::max(window);
        for (i, &v) in values.iter().enumerate() {
            rolling.push(v);
            assert_eq!(
                rolling.value().unwrap(),
                naive_max(&values, i, window),
                "max mismatch at i={i}, window={window}"
            );
        }
    }
}

#[test]
fn monotonic_window_matches_naive_min() {
    let values = series(5_000);
    for window in [1usize, 3, 21, 144] {
        let mut rolling = MonotonicWindow::min(window);
        for (i, &v) in values.iter().enumerate() {
            rolling.push(v);
            assert_eq!(
                rolling.value().unwrap(),
                naive_min(&values, i, window),
                "min mismatch at i={i}, window={window}"
            );
        }
    }
}

#[test]
fn monotonic_window_reports_the_bar_that_made_the_extreme() {
    let mut rolling = MonotonicWindow::max(3);
    for v in [1.0, 5.0, 2.0] {
        rolling.push(v);
    }
    assert_eq!(rolling.index(), Some(1));

    // Index 1 is still inside a 3-bar window ending at index 3.
    rolling.push(3.0);
    assert_eq!(rolling.value(), Some(5.0));
    assert_eq!(rolling.index(), Some(1));

    // Now it ages out, and the extreme moves to the best of what remains.
    rolling.push(4.0);
    assert_eq!(rolling.value(), Some(4.0));
    assert_eq!(rolling.index(), Some(4));
}

#[test]
fn monotonic_window_handles_a_plateau() {
    // Equal values must not accumulate in the deque or the eviction logic
    // silently reports a stale index.
    let mut rolling = MonotonicWindow::max(3);
    for _ in 0..10 {
        rolling.push(2.0);
    }
    assert_eq!(rolling.value(), Some(2.0));
    rolling.push(1.0);
    assert_eq!(rolling.value(), Some(2.0));
}

#[test]
fn rolling_stats_match_naive() {
    let values = series(2_000);
    let window = 64;
    let mut rolling = RollingStats::new(window);

    for (i, &v) in values.iter().enumerate() {
        rolling.push(v);
        if i + 1 < window {
            continue;
        }
        let slice = &values[i + 1 - window..=i];
        let mean = slice.iter().sum::<f64>() / window as f64;
        let variance =
            slice.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / window as f64;

        assert!((rolling.mean() - mean).abs() < 1e-9, "mean drift at {i}");
        assert!(
            (rolling.variance() - variance).abs() < 1e-9,
            "variance drift at {i}"
        );
    }
}

#[test]
fn rolling_variance_never_goes_negative() {
    // Constant input drives the running sums into exact cancellation, which is
    // where a naive formula produces a tiny negative and then NaN via sqrt.
    let mut rolling = RollingStats::new(32);
    for _ in 0..500 {
        rolling.push(1.23456789);
    }
    assert!(rolling.variance() >= 0.0);
    assert!(rolling.std_dev().is_finite());
}

#[test]
fn wilder_is_not_an_ema() {
    // The two differ by their smoothing factor. Confusing them misplaces every
    // ATR-derived stop, so this asserts they actually diverge.
    let values = series(300);
    let mut wilder = Wilder::new(14);
    let mut ema = Ema::new(14);

    for &v in &values {
        wilder.push(v);
        ema.push(v);
    }

    let w = wilder.value().unwrap();
    let e = ema.value().unwrap();
    assert!(w.is_finite() && e.is_finite());
    assert!((w - e).abs() > 1e-9, "Wilder and EMA should not coincide");
}

#[test]
fn wilder_seeds_with_a_simple_average() {
    let mut wilder = Wilder::new(5);
    for v in [1.0, 2.0, 3.0, 4.0, 5.0] {
        wilder.push(v);
    }
    assert!(wilder.is_warm());
    assert!((wilder.value().unwrap() - 3.0).abs() < 1e-12);
}

#[test]
fn wilder_is_cold_until_its_period_is_filled() {
    let mut wilder = Wilder::new(10);
    for i in 0..9 {
        wilder.push(i as f64);
        assert!(wilder.value().is_none());
    }
    wilder.push(9.0);
    assert!(wilder.value().is_some());
}

#[test]
fn atr_first_bar_uses_plain_range() {
    let mut atr = Atr::new(1);
    atr.push(1.1, 1.0, 1.05);
    // With no previous close there is nothing to gap against.
    assert!((atr.value().unwrap() - 0.1).abs() < 1e-12);
}

#[test]
fn atr_accounts_for_gaps() {
    let mut atr = Atr::new(2);
    atr.push(1.10, 1.00, 1.05);
    // Next bar opens far above: true range must span the gap, not just the bar.
    atr.push(2.05, 2.00, 2.02);
    let value = atr.value().unwrap();
    assert!(value > 0.1, "gap should dominate the bar's own range, got {value}");
}
