//! The lookahead guarantee, asserted directly.
//!
//! This is the property the whole engine rests on: at base bar `i`, the
//! higher-timeframe bar on offer must have *closed* at or before `i` opened.
//! Get it wrong and the backtest reads candles from the future, which is the
//! most common way a strategy appears to work and then doesn't.

use backtest_core::engine::align::Alignment;
use backtest_core::store::{write_bars, Bars, InputBar};
use backtest_core::Timeframe;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("align-test-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `n` consecutive bars of `timeframe`, starting at a clean boundary.
fn bars_of(timeframe: Timeframe, n: usize, start: i64) -> Vec<InputBar> {
    (0..n)
        .map(|i| {
            let t = start + i as i64 * timeframe.seconds();
            InputBar {
                time: t,
                open: 1.0,
                high: 1.1,
                low: 0.9,
                close: 1.0,
                volume: 1,
                spread: 1,
            }
        })
        .collect()
}

fn build(dir: &std::path::Path, tf: Timeframe, n: usize, start: i64) -> Bars {
    let path = dir.join(format!("{}.ttb", tf.as_str()));
    write_bars(&path, "EURUSD", tf, &bars_of(tf, n, start)).unwrap();
    Bars::open(&path).unwrap()
}

#[test]
fn never_exposes_an_unclosed_higher_timeframe_bar() {
    let dir = temp_dir("nolookahead");
    // A week of M5 and the H4 bars over the same span, both from a 4h boundary.
    let start = 1_700_000_000 - (1_700_000_000 % 14_400);
    let m5 = build(&dir, Timeframe::M5, 2_016, start);
    let h4 = build(&dir, Timeframe::H4, 84, start);

    let alignment = Alignment::build(&m5, &h4);
    let m5_times = m5.time();
    let h4_times = h4.time();
    let h4_duration = Timeframe::H4.seconds();

    for i in 0..m5.len() {
        if let Some(j) = alignment.at(i) {
            let close_time = h4_times[j] + h4_duration;
            assert!(
                close_time <= m5_times[i],
                "bar {i} at {} can see H4 bar {j} closing at {close_time} — that is the future",
                m5_times[i]
            );

            // And it must be the *latest* such bar, or the strategy is reading
            // stale context rather than unsafe context.
            if j + 1 < h4_times.len() {
                assert!(
                    h4_times[j + 1] + h4_duration > m5_times[i],
                    "bar {i} should have advanced to H4 bar {}",
                    j + 1
                );
            }
        } else {
            // No mapping means no H4 bar had closed yet — only legal early on.
            assert!(
                h4_times[0] + h4_duration > m5_times[i],
                "bar {i} has no H4 context but one had already closed"
            );
        }
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn first_bars_have_no_higher_context() {
    let dir = temp_dir("warmup");
    let start = 1_700_000_000 - (1_700_000_000 % 14_400);
    let m5 = build(&dir, Timeframe::M5, 200, start);
    let h4 = build(&dir, Timeframe::H4, 10, start);

    let alignment = Alignment::build(&m5, &h4);

    // The first H4 bar opens with the first M5 bar and closes 48 M5 bars later,
    // so nothing before index 48 may see it.
    for i in 0..48 {
        assert_eq!(alignment.at(i), None, "bar {i} should have no H4 context");
    }
    assert_eq!(alignment.at(48), Some(0));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn flags_the_bar_where_higher_timeframe_state_turns_over() {
    let dir = temp_dir("fresh");
    let start = 1_700_000_000 - (1_700_000_000 % 14_400);
    let m5 = build(&dir, Timeframe::M5, 300, start);
    let h4 = build(&dir, Timeframe::H4, 10, start);

    let alignment = Alignment::build(&m5, &h4);

    // Exactly one turnover per closed H4 bar — this is what lets step 4 of the
    // build order recompute D1/H4 on close instead of on every M5 tick.
    let fresh: Vec<usize> = (0..m5.len()).filter(|&i| alignment.is_fresh(i)).collect();

    assert_eq!(fresh, vec![48, 96, 144, 192, 240, 288]);
    for &i in &fresh {
        assert!(alignment.at(i).is_some());
        assert_ne!(alignment.at(i), alignment.at(i - 1));
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn handles_a_higher_series_that_starts_later() {
    // Real broker history is ragged: H4 may go back further than M5, or not as
    // far. Neither should produce a panic or a bogus mapping.
    let dir = temp_dir("ragged");
    let start = 1_700_000_000 - (1_700_000_000 % 14_400);
    let m5 = build(&dir, Timeframe::M5, 500, start);
    let h4 = build(&dir, Timeframe::H4, 5, start + 14_400 * 3);

    let alignment = Alignment::build(&m5, &h4);
    assert_eq!(alignment.len(), m5.len());
    assert_eq!(alignment.at(0), None);
    assert!(alignment.at(m5.len() - 1).is_some());

    std::fs::remove_dir_all(&dir).ok();
}
