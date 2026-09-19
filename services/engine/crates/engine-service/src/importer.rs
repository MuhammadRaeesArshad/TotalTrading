//! Fills the bar cache from `mt5-connector`.
//!
//! # Why this is not trivial
//!
//! MT5 will not hand over a decade of M5 in one call. The terminal keeps only
//! as much history as its *Max bars in chart* setting allows, and a single
//! `copy_rates_range` over years either truncates or returns nothing at all.
//! So the import walks the window forward in chunks and stitches the results.
//!
//! Three things make stitching safe rather than hopeful:
//!
//! - **Chunks overlap.** A boundary that lands mid-bar would otherwise drop
//!   that bar entirely. Overlapping and de-duplicating by timestamp is cheaper
//!   than getting the arithmetic exactly right against nine timeframes.
//! - **Timestamps are the identity.** Bars are collected into a `BTreeMap`
//!   keyed by open time, so a bar seen twice is stored once and the result is
//!   sorted by construction. `write_bars` rejects anything out of order, which
//!   makes a stitching bug a loud failure instead of silent corruption.
//! - **Empty chunks are normal.** Weekends and holidays have no bars. An empty
//!   response means "nothing here", not "something went wrong" — but a long
//!   unbroken run of them means the terminal has no history that far back, and
//!   that *is* worth reporting.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use engine_core::store::{cache_path, write_bars, Bars, InputBar};
use engine_core::Timeframe;
use serde::{Deserialize, Serialize};

/// Credentials for one import. Held only for the length of the call and never
/// written anywhere — the gateway is the only component that stores them.
#[derive(Clone, Deserialize)]
pub struct Credentials {
    pub login: String,
    pub password: String,
    pub server: String,
}

impl std::fmt::Debug for Credentials {
    /// Redacted, so a stray `{:?}` in a log line cannot leak a broker password.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("login", &self.login)
            .field("server", &self.server)
            .field("password", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Deserialize)]
pub struct ImportSpec {
    pub credentials: Credentials,
    pub symbols: Vec<String>,
    pub timeframes: Vec<String>,
    pub from_ts: i64,
    pub to_ts: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedSeries {
    pub symbol: String,
    pub timeframe: String,
    /// Bars in the cache after this import.
    pub bars: usize,
    /// Bars this import added. Zero on a top-up with nothing new.
    pub added: usize,
    /// True when an existing cached series was topped up rather than built.
    pub incremental: bool,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
    /// Bars returned more than once across overlapping chunks. Expected to be
    /// non-zero; a zero here usually means the chunks are not overlapping.
    pub duplicates_dropped: usize,
    pub path: String,
    /// Set when the terminal had less history than was asked for. Not an
    /// error — brokers cap lower timeframes hard — but it decides what date
    /// range is honest to backtest over.
    pub short_of_request: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportFailure {
    pub symbol: String,
    pub timeframe: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportReport {
    pub imported: Vec<ImportedSeries>,
    pub failed: Vec<ImportFailure>,
    pub total_bars: usize,
    pub elapsed_ms: u128,
}

#[derive(Debug, Deserialize)]
struct WireCandle {
    time: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    tick_volume: u64,
    #[serde(default)]
    spread: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("mt5-connector said: {0}")]
    Connector(String),

    // ureq already names the URL in its own Display, so this adds the
    // actionable part rather than repeating it.
    #[error("cannot reach mt5-connector ({source}). Is it running on the machine with the MT5 terminal?")]
    Unreachable {
        #[source]
        source: Box<ureq::Error>,
    },

    #[error("{0} is not a timeframe this engine knows")]
    UnknownTimeframe(String),

    #[error("no bars came back for {symbol} {timeframe} in that window — the terminal's \
             'Max bars in chart' setting may not reach that far back")]
    NoBars { symbol: String, timeframe: String },

    #[error("could not write the bar cache: {0}")]
    Write(#[from] engine_core::CoreError),

    #[error("could not read the connector's reply: {0}")]
    Decode(String),
}

/// How many bars to ask for per chunk. Comfortably under what a default MT5
/// install will return, and small enough that a failure costs little to retry.
const CHUNK_BARS: i64 = 20_000;

/// Overlap between chunks, in bars. Two is enough to never lose a boundary bar.
const OVERLAP_BARS: i64 = 2;

/// Consecutive empty chunks before concluding there is no history here. At one
/// chunk per ~20k bars, three in a row is far more than any holiday.
const EMPTY_CHUNKS_BEFORE_STOP: usize = 3;

/// Live progress of one import, shared with whoever is watching it. An import
/// of 28 pairs from 2011 takes minutes; the caller must be able to see where
/// it is without waiting for the end.
#[derive(Debug, Default)]
pub struct ImportProgress {
    pub series_total: AtomicUsize,
    pub series_done: AtomicUsize,
    pub bars_done: AtomicUsize,
    /// "EURUSD H1" while that series is being pulled.
    pub current: Mutex<String>,
}

pub fn import(
    connector_url: &str,
    cache_root: &Path,
    spec: &ImportSpec,
    progress: &ImportProgress,
) -> ImportReport {
    let started = std::time::Instant::now();
    let mut report = ImportReport::default();
    progress
        .series_total
        .store(spec.symbols.len() * spec.timeframes.len(), Ordering::Relaxed);

    for symbol in &spec.symbols {
        for timeframe in &spec.timeframes {
            if let Ok(mut current) = progress.current.lock() {
                *current = format!("{symbol} {timeframe}");
            }
            let outcome = import_one(connector_url, cache_root, spec, symbol, timeframe);
            progress.series_done.fetch_add(1, Ordering::Relaxed);
            match outcome {
                Ok(series) => {
                    progress.bars_done.fetch_add(series.bars, Ordering::Relaxed);
                    report.total_bars += series.bars;
                    report.imported.push(series);
                }
                Err(e) => {
                    // One bad symbol must not abandon the rest of the import —
                    // a broker that does not offer NZDCHF is not a reason to
                    // skip the other twenty-seven pairs.
                    tracing::warn!(%symbol, %timeframe, error = %e, "import failed");
                    report.failed.push(ImportFailure {
                        symbol: symbol.clone(),
                        timeframe: timeframe.clone(),
                        error: e.to_string(),
                    });
                }
            }
        }
    }

    report.elapsed_ms = started.elapsed().as_millis();
    report
}

fn import_one(
    connector_url: &str,
    cache_root: &Path,
    spec: &ImportSpec,
    symbol: &str,
    timeframe_raw: &str,
) -> Result<ImportedSeries, ImportError> {
    let timeframe: Timeframe = timeframe_raw
        .parse()
        .map_err(|_| ImportError::UnknownTimeframe(timeframe_raw.to_string()))?;

    let step = timeframe.seconds();
    let chunk_span = step * CHUNK_BARS;
    let overlap = step * OVERLAP_BARS;
    let path = cache_path(cache_root, symbol, timeframe)?;

    // BTreeMap keyed by open time: de-duplicates overlaps and sorts in one go.
    let mut collected: BTreeMap<i64, InputBar> = BTreeMap::new();

    // Incremental: start from what is already cached and fetch only the gaps
    // at either end. Years of history are pulled once; a later import tops up
    // in seconds. An unreadable file is ignored and rebuilt in full.
    let cached = load_cached(&path, &mut collected);
    let windows = gaps_to_fetch(cached, spec.from_ts, spec.to_ts, overlap);

    let before = collected.len();
    let mut duplicates = 0usize;
    for (from, to) in windows {
        fetch_range(
            connector_url, spec, symbol, timeframe_raw, step, from, to,
            &mut collected, &mut duplicates,
        )?;
    }
    // Overlap with the cached ends is expected, not a sign of a problem.
    let added = collected.len() - before;

    if collected.is_empty() {
        return Err(ImportError::NoBars {
            symbol: symbol.to_string(),
            timeframe: timeframe_raw.to_string(),
        });
    }

    let bars: Vec<InputBar> = collected.into_values().collect();
    let first_ts = bars.first().map(|b| b.time);
    let last_ts = bars.last().map(|b| b.time);

    // A whole chunk's worth short of what was asked for is worth saying out
    // loud — it is the difference between "backtest from 2015" and "you have
    // data from 2022".
    let short_of_request = first_ts.and_then(|first| {
        (first > spec.from_ts + chunk_span).then(|| {
            format!(
                "history starts at {first}, not the requested {}. The terminal \
                 does not keep {timeframe_raw} that far back.",
                spec.from_ts
            )
        })
    });

    // Nothing new: leave the file alone rather than rewrite identical bytes.
    if cached.is_none() || added > 0 {
        write_bars(&path, symbol, timeframe, &bars)?;
    }

    Ok(ImportedSeries {
        symbol: symbol.to_string(),
        timeframe: timeframe_raw.to_string(),
        bars: bars.len(),
        added,
        incremental: cached.is_some(),
        first_ts,
        last_ts,
        duplicates_dropped: duplicates,
        path: path.display().to_string(),
        short_of_request,
    })
}

/// The ranges still missing from a cached series `(first, last)`: older
/// history if the request reaches further back, and anything newer than the
/// last bar. Each overlaps the cached edge so a boundary bar is never lost.
/// No cache means the whole request.
pub fn gaps_to_fetch(cached: Option<(i64, i64)>, from: i64, to: i64, overlap: i64) -> Vec<(i64, i64)> {
    let Some((first, last)) = cached else {
        return vec![(from, to)];
    };
    let mut gaps = Vec::with_capacity(2);
    if from < first {
        gaps.push((from, first + overlap));
    }
    if to > last {
        gaps.push(((last - overlap).max(from), to));
    }
    gaps
}

/// Loads a cached series into `into` and returns its first and last bar time,
/// or `None` when there is no usable file. The mapping is dropped before
/// returning, so the file can be replaced afterwards.
fn load_cached(path: &Path, into: &mut BTreeMap<i64, InputBar>) -> Option<(i64, i64)> {
    let bars = Bars::open(path).ok()?;
    if bars.is_empty() {
        return None;
    }
    let (t, o, h, l, c, v, sp) = (
        bars.time(), bars.open_px(), bars.high(), bars.low(), bars.close(), bars.volume(), bars.spread(),
    );
    for i in 0..bars.len() {
        into.insert(t[i], InputBar {
            time: t[i], open: o[i], high: h[i], low: l[i], close: c[i], volume: v[i], spread: sp[i],
        });
    }
    Some((t[0], t[bars.len() - 1]))
}

/// Pulls `[from, to)` in overlapping chunks into `collected`.
#[allow(clippy::too_many_arguments)]
fn fetch_range(
    connector_url: &str,
    spec: &ImportSpec,
    symbol: &str,
    timeframe_raw: &str,
    step: i64,
    from: i64,
    to: i64,
    collected: &mut BTreeMap<i64, InputBar>,
    duplicates: &mut usize,
) -> Result<(), ImportError> {
    let chunk_span = step * CHUNK_BARS;
    let overlap = step * OVERLAP_BARS;
    let mut found_here = 0usize;
    let mut consecutive_empty = 0usize;

    let mut cursor = from;
    while cursor < to {
        let chunk_end = (cursor + chunk_span).min(to);
        let candles = fetch_chunk(connector_url, &spec.credentials, symbol, timeframe_raw, cursor, chunk_end)?;

        if candles.is_empty() {
            consecutive_empty += 1;
            if consecutive_empty >= EMPTY_CHUNKS_BEFORE_STOP && found_here == 0 {
                // Nothing in this range, repeatedly — typically asking for
                // history older than the terminal holds. Walking the rest one
                // chunk at a time would just be slow about saying the same thing.
                break;
            }
        } else {
            consecutive_empty = 0;
        }

        for candle in candles {
            let bar = to_input_bar(&candle)?;
            found_here += 1;
            if collected.insert(bar.time, bar).is_some() {
                *duplicates += 1;
            }
        }

        // Step back by the overlap so a bar straddling the boundary is caught.
        cursor = (chunk_end - overlap).max(cursor + step);
    }
    Ok(())
}

fn fetch_chunk(
    connector_url: &str,
    credentials: &Credentials,
    symbol: &str,
    timeframe: &str,
    from_ts: i64,
    to_ts: i64,
) -> Result<Vec<WireCandle>, ImportError> {
    let url = format!("{}/candles/range", connector_url.trim_end_matches('/'));

    let response = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(120))
        .send_json(ureq::json!({
            "login": credentials.login,
            "password": credentials.password,
            "server": credentials.server,
            "symbol": symbol,
            "timeframe": timeframe,
            "from_ts": from_ts,
            "to_ts": to_ts,
        }));

    match response {
        Ok(ok) => ok
            .into_json::<Vec<WireCandle>>()
            .map_err(|e| ImportError::Decode(e.to_string())),

        // A 4xx carries the connector's own explanation, which is the useful
        // one — it is what MT5 actually said.
        Err(ureq::Error::Status(_, res)) => {
            let detail = res
                .into_json::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
                .unwrap_or_else(|| "unknown error".into());
            Err(ImportError::Connector(detail))
        }

        Err(e) => Err(ImportError::Unreachable { source: Box::new(e) }),
    }
}

fn to_input_bar(candle: &WireCandle) -> Result<InputBar, ImportError> {
    Ok(InputBar {
        time: parse_rfc3339_seconds(&candle.time)
            .ok_or_else(|| ImportError::Decode(format!("bad timestamp {:?}", candle.time)))?,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.tick_volume.min(u32::MAX as u64) as u32,
        spread: candle.spread.clamp(0, u16::MAX as i64) as u16,
    })
}

/// Minimal RFC 3339 to unix seconds.
///
/// Hand-rolled rather than pulling in `chrono` for one parse of one shape.
/// The connector always emits UTC (`...Z` or `+00:00`) because it builds every
/// timestamp from a tz-aware UTC datetime — anything else is rejected rather
/// than silently misread, since a timezone mistake here shifts every bar.
fn parse_rfc3339_seconds(raw: &str) -> Option<i64> {
    let bytes = raw.as_bytes();
    if bytes.len() < 19 {
        return None;
    }

    let num = |from: usize, to: usize| -> Option<i64> {
        raw.get(from..to)?.parse::<i64>().ok()
    };

    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;

    let offset = raw.get(19..).unwrap_or("");
    let utc = offset.is_empty()
        || offset.starts_with('Z')
        || offset.contains("+00:00")
        || offset.starts_with(".") && (offset.ends_with('Z') || offset.contains("+00:00"));
    if !utc {
        return None;
    }

    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Howard Hinnant's `days_from_civil`: civil date to days since 1970-01-01.
/// Exact for the whole proleptic Gregorian calendar, no lookup tables.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year =
        (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era =
        year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_timestamps_the_connector_emits() {
        assert_eq!(parse_rfc3339_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_seconds("2023-11-14T20:00:00Z"), Some(1_699_992_000));
        assert_eq!(
            parse_rfc3339_seconds("2023-11-14T20:00:00+00:00"),
            Some(1_699_992_000)
        );
    }

    #[test]
    fn handles_leap_days_and_century_rules() {
        // 2000 is a leap year, 1900 is not. A table-free implementation that
        // gets this wrong is off by a day for decades.
        assert_eq!(parse_rfc3339_seconds("2000-02-29T00:00:00Z"), Some(951_782_400));
        assert_eq!(parse_rfc3339_seconds("2024-02-29T12:00:00Z"), Some(1_709_208_000));
    }

    #[test]
    fn refuses_a_non_utc_timestamp_rather_than_guessing() {
        // Reading a broker-time bar as UTC shifts the whole series silently.
        assert_eq!(parse_rfc3339_seconds("2023-11-14T20:00:00+02:00"), None);
        assert_eq!(parse_rfc3339_seconds("not-a-time"), None);
        assert_eq!(parse_rfc3339_seconds("2023-11-14"), None);
    }

    #[test]
    fn credentials_never_print_the_password() {
        let creds = Credentials {
            login: "51234567".into(),
            password: "hunter2-and-then-some".into(),
            server: "ICMarketsSC-Demo".into(),
        };
        let printed = format!("{creds:?}");
        assert!(!printed.contains("hunter2"), "password leaked: {printed}");
        assert!(printed.contains("51234567"));
    }
}

#[cfg(test)]
mod incremental_tests {
    use super::*;

    const H: i64 = 3_600;

    #[test]
    fn with_nothing_cached_the_whole_request_is_fetched() {
        assert_eq!(gaps_to_fetch(None, 100, 900, 2 * H), vec![(100, 900)]);
    }

    #[test]
    fn a_top_up_fetches_only_what_is_newer_than_the_last_bar() {
        let gaps = gaps_to_fetch(Some((1_000 * H, 2_000 * H)), 1_000 * H, 2_100 * H, 2 * H);
        assert_eq!(gaps, vec![(1_998 * H, 2_100 * H)], "from just before the last bar, not from the start");
    }

    #[test]
    fn asking_for_older_history_backfills_the_front_too() {
        let gaps = gaps_to_fetch(Some((1_000 * H, 2_000 * H)), 500 * H, 2_100 * H, 2 * H);
        assert_eq!(gaps, vec![(500 * H, 1_002 * H), (1_998 * H, 2_100 * H)]);
    }

    #[test]
    fn a_request_already_covered_fetches_nothing() {
        assert!(gaps_to_fetch(Some((1_000 * H, 2_000 * H)), 1_200 * H, 1_800 * H, 2 * H).is_empty());
    }

    #[test]
    fn a_cached_series_loads_back_exactly() {
        let dir = std::env::temp_dir().join(format!("import-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("EURUSD-H1.ttb");
        let input: Vec<InputBar> = (0..5)
            .map(|i| InputBar {
                time: 1_700_000_000 + i * H, open: 1.1, high: 1.2, low: 1.0, close: 1.15,
                volume: 10 + i as u32, spread: 3,
            })
            .collect();
        write_bars(&path, "EURUSD", Timeframe::H1, &input).unwrap();

        let mut map = BTreeMap::new();
        let span = load_cached(&path, &mut map);
        assert_eq!(span, Some((input[0].time, input[4].time)));
        assert_eq!(map.len(), 5);
        assert_eq!(map[&input[2].time].volume, 12, "volume and spread survive the round trip");
        assert!(load_cached(&dir.join("missing.ttb"), &mut BTreeMap::new()).is_none());
    }
}
