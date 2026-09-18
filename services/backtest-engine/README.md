# backtest-engine

Replays historical candles through the strategy's detection functions and
produces a trade log, equity curve and metrics. Written in Rust because this
is the one service whose job is to chew through tens of millions of bars.

## Measured throughput

Single core, release build, 200-bar rolling high/low plus ATR per bar:

```
scan: 10,000,000 bars in 340ms
  29.4M bars/sec
  34 ns/bar
```

Ten years of M5 across 28 pairs is roughly 29M bars — about a second on one
core, and it parallelises across pairs from there. Reproduce it with:

```bash
cargo run --release --example throughput -p backtest-core -- 10000000
```

Always measure in release. Debug is ~50× slower and tells you nothing.

## Where the speed comes from

Four decisions, in order of how much they matter:

1. **Bars live in a mmap'd columnar file, not in Mongo.** Pulling 20M bars
   through BSON means a document allocation and a field parse per bar, which
   costs more than the entire simulation it feeds. A `.ttb` file is `mmap`,
   cast, iterate — no parse, no allocation, no copy. See
   `crates/backtest-core/src/store/format.rs`.
2. **Columns, not rows.** A pass reading only `high` and `low` touches a
   fraction of the cache lines a row layout would, and each column is a
   contiguous `&[f64]` the autovectoriser can work with.
3. **O(1) sliding windows.** A rolling 200-bar high recomputed naively is
   O(n·w) — four billion comparisons over 20M bars, for one indicator on one
   pair. The monotonic deque in `engine/rolling.rs` makes it O(n): each index
   is pushed once and popped once, regardless of window width.
4. **Multi-timeframe alignment precomputed once.** The map from each M5 bar to
   the last *closed* H4 bar is built in a single linear merge, so higher-
   timeframe context is an array index in the hot loop rather than a search.

Two more that matter at the margins: detection runs across pairs on rayon
(`ScanTask` per symbol, nothing shared), and open positions carry a resume
cursor so the exit search never re-walks a position from its entry bar.

## What it refuses to do

**Look ahead.** A detector never receives the bar array. It receives a
`BarCtx`, which exposes the series only up to the current bar and has no
method that reaches forward — lookahead is a compile error, not a suspiciously
good equity curve. Higher-timeframe context goes through the same gate: you
get the last bar that has *closed*, never the one still forming.
`tests/alignment.rs` asserts this directly.

**Pretend an ambiguous bar is a win.** When a bar's range contains both the
stop and the target, the data genuinely cannot say which came first. The
default `IntrabarPolicy::Pessimistic` assumes the stop, and every such trade is
flagged. `Metrics::ambiguous_exits` tells you how much of a result rests on
that assumption — worth reading next to the headline number.

**Round position size up.** Sizing rounds down to the broker's volume step.
Rounding up quietly exceeds the configured risk on every trade. A trade that
cannot be placed at the minimum lot is skipped, not resized.

**Enter on the signal bar's close.** Entry fills on the *next* bar's open,
moved against the trade by spread and slippage. The signal bar's close is only
knowable once that bar is over.

## What is deliberately missing

**The rules.** `DetectorRegistry` starts empty and `POST /runs` returns 422
with an explanation. The strategy definition is still being redefined (project
spec §3), and a placeholder here would get shared straight into the live
scanner — two implementations of rules nobody has agreed on, which is exactly
the failure `strategy-engine` and this service exist to avoid.

When the definition lands: implement `Detector`, register the factory in
`build_registry()` in `crates/backtest-service/src/main.rs`. Nothing else
changes.

**Mongo persistence.** Results currently live in the job registry. Writing
them into the `backtests` and `trades` collections is next; the document shape
is already fixed by `api-gateway/src/schemas/backtest.schema.ts`, and
`engineVersion` on that document records which implementation produced a run
so Python and Rust results stay distinguishable.

**The bar importer.** `write_bars` is the API; the job that pulls history out
of `mt5-connector` and fills the cache is not written yet. Check how far back
the broker's M5 and M15 actually go before assuming a date range (spec §6.7) —
lower timeframes are usually capped well short of what you would want.

## Layout

```
crates/backtest-core/      the hot path. Sync, no network, minimal deps.
  store/format.rs          the .ttb layout and why it exists
  store/bars.rs            mmap reader, zero-copy column access
  store/writer.rs          atomic writer (temp file + rename)
  engine/rolling.rs        O(1) monotonic window, rolling stats, Wilder, ATR
  engine/align.rs          multi-timeframe mapping, no-lookahead
  engine/window.rs         BarCtx — the only view a detector gets
  engine/detector.rs       the trait, and the hole where the rules go
  engine/sim.rs            fills, sizing, intrabar policy, P&L
  engine/metrics.rs        streaming equity curve and metrics
  engine/runner.rs         parallel detection, sequential portfolio
crates/backtest-service/   axum HTTP, job queue, progress
```

## HTTP API

| Method | Path                 | Does                                        |
|--------|----------------------|---------------------------------------------|
| GET    | `/health`            | Status, cores, cache path, registered rules |
| GET    | `/detectors`         | What can be run                             |
| POST   | `/runs`              | Queue a run; returns `202` and an id        |
| GET    | `/runs`              | All runs, newest first, without trade logs  |
| GET    | `/runs/:id`          | One run, with its full result               |
| GET    | `/runs/:id/progress` | Progress only — cheap to poll               |
| DELETE | `/runs/:id`          | Cancel; lands within a few thousand bars    |

```bash
curl -X POST localhost:8004/runs -H 'Content-Type: application/json' -d '{
  "detector": "your-strategy",
  "symbols": ["EURUSD", "GBPUSD"],
  "timeframe": "M5",
  "higher_timeframes": ["H4", "D1"],
  "from_ts": 1577836800,
  "to_ts": 1735689600,
  "sim": { "initial_balance": 10000, "risk_percent": 1.0 }
}'
```

Runs execute on `spawn_blocking` — the engine is CPU-bound and would otherwise
stall every other request for the length of a scan.

## Running it

```bash
cargo test                                  # 33 tests
cargo build --release -p backtest-service
BAR_CACHE_DIR=./bars ./target/release/backtest-service
```

MSRV is 1.75 and `Cargo.lock` is pinned to match, because that is what this was
verified against. On a newer toolchain, `cargo update` freely.

`BAR_CACHE_DIR` must be a real filesystem — the bar files are memory-mapped, so
a network mount will be slow and an overlay in a container will not persist.
