//! Round-trips through the `.ttb` format, and the corruption it must reject.

use engine_core::store::{cache_path, write_bars, Bars, InputBar};
use engine_core::Timeframe;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "ttb-test-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn sample(n: usize) -> Vec<InputBar> {
    (0..n)
        .map(|i| {
            let base = 1.0850 + (i as f64 / 50.0).sin() * 0.003;
            InputBar {
                time: 1_700_000_000 + i as i64 * 300,
                open: base,
                high: base + 0.0005,
                low: base - 0.0005,
                close: base + 0.0002,
                volume: 100 + i as u32,
                spread: (i % 20) as u16,
            }
        })
        .collect()
}

#[test]
fn round_trips_every_column() {
    let dir = temp_dir("roundtrip");
    let path = cache_path(&dir, "EURUSD", Timeframe::M5).unwrap();
    let input = sample(10_000);

    write_bars(&path, "EURUSD", Timeframe::M5, &input).unwrap();
    let bars = Bars::open(&path).unwrap();

    assert_eq!(bars.symbol(), "EURUSD");
    assert_eq!(bars.timeframe(), Timeframe::M5);
    assert_eq!(bars.len(), input.len());

    for (i, expected) in input.iter().enumerate() {
        assert_eq!(bars.time()[i], expected.time, "time at {i}");
        assert_eq!(bars.open_px()[i], expected.open, "open at {i}");
        assert_eq!(bars.high()[i], expected.high, "high at {i}");
        assert_eq!(bars.low()[i], expected.low, "low at {i}");
        assert_eq!(bars.close()[i], expected.close, "close at {i}");
        assert_eq!(bars.volume()[i], expected.volume, "volume at {i}");
        assert_eq!(bars.spread()[i], expected.spread, "spread at {i}");
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn columns_are_aligned_for_zero_copy_casts() {
    // A bar count that is deliberately not a round number — the padding logic
    // is what keeps the f64 columns 8-aligned, and an off-by-one there is UB
    // rather than a wrong answer.
    let dir = temp_dir("align");
    for count in [1usize, 7, 63, 64, 65, 1_001] {
        let path = dir.join(format!("{count}.ttb"));
        write_bars(&path, "EURUSD", Timeframe::H1, &sample(count)).unwrap();
        let bars = Bars::open(&path).unwrap();
        assert_eq!(bars.len(), count);
        assert_eq!(bars.close().len(), count);
        // Touch the last element of every column: a short mapping faults here.
        assert!(bars.close()[count - 1].is_finite());
        assert!(bars.spread()[count - 1] < u16::MAX);
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rejects_a_file_that_is_not_a_bar_file() {
    let dir = temp_dir("magic");
    let path = dir.join("junk.ttb");
    std::fs::write(&path, vec![0u8; 256]).unwrap();
    assert!(Bars::open(&path).is_err());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rejects_a_truncated_file() {
    let dir = temp_dir("truncated");
    let path = dir.join("short.ttb");
    write_bars(&path, "EURUSD", Timeframe::M5, &sample(1_000)).unwrap();

    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();

    let err = Bars::open(&path).unwrap_err().to_string();
    assert!(err.contains("Truncated") || err.contains("holds"), "got: {err}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn refuses_to_write_unordered_bars() {
    // A duplicated or reversed timestamp from a bad import is silent
    // corruption everywhere downstream, so it is caught at the door.
    let dir = temp_dir("unordered");
    let mut input = sample(100);
    input[50].time = input[49].time;

    let err = write_bars(dir.join("bad.ttb"), "EURUSD", Timeframe::M5, &input).unwrap_err();
    assert!(err.to_string().contains("increasing"), "got: {err}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn bisects_a_date_range() {
    let dir = temp_dir("range");
    let path = dir.join("r.ttb");
    let input = sample(1_000);
    write_bars(&path, "EURUSD", Timeframe::M5, &input).unwrap();
    let bars = Bars::open(&path).unwrap();

    let from = input[100].time;
    let to = input[199].time;
    let (start, end) = bars.range(from, to);

    assert_eq!(start, 100);
    assert_eq!(end, 200, "range is half-open and must include the `to` bar");

    // A window entirely before the data yields an empty, non-inverted range.
    let (s, e) = bars.range(0, 1);
    assert_eq!(s, 0);
    assert_eq!(e, 0);

    std::fs::remove_dir_all(&dir).ok();
}

// Symbols arrive over HTTP and become directory names.
#[test]
fn cache_path_refuses_anything_that_could_leave_the_cache() {
    let root = std::env::temp_dir();
    for bad in ["../etc", "..", ".", "a/b", r"a\b", "", "/abs", ".hidden"] {
        assert!(cache_path(&root, bad, Timeframe::H1).is_err(), "should refuse {bad:?}");
    }
    for good in ["EURUSD", "EURUSD.a", "EURUSDm", "GER40_i", "#US30", "XAU-USD"] {
        assert!(cache_path(&root, good, Timeframe::H1).is_ok(), "should accept {good:?}");
    }
}
