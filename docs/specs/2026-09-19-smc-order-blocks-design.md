# Strategy: trend + order blocks (Smart Money Concepts)

**Date:** 2026-09-19
**Detector name:** `smc_ob`
**Status:** approved, implementing

The first strategy through the engine. Explicitly a test of the pipeline rather than a
claimed edge — canonical SMC definitions, every threshold in config, the priority being an
end-to-end run with honest numbers.

"SMC order blocks" has several incompatible definitions in circulation. The three that
change results most were decided explicitly; everything else is a stated default.

## Decided

**Trend is swing break of structure.** A swing high is a bar whose high exceeds the highs
of `swing_lookback` bars on *both* sides; swing low mirrors it. Trend turns bullish when a
bar closes above the last *confirmed* swing high, bearish when a bar closes below the last
confirmed swing low. Before the first break, trend is neutral and nothing is taken.

A swing is only confirmed `swing_lookback` bars after it forms. That lag is real and is not
worked around — `BarCtx` cannot see forward, so the detector learns about a swing exactly
when a live scanner would.

*Rejected:* a higher-timeframe EMA filter (not SMC structure, and order blocks would need a
different anchor than the break); counting higher-highs and higher-lows (still needs a swing
definition underneath, so it is this with extra steps).

**An order block is the last opposing candle before the impulse.** On a bullish break, walk
back from the breaking bar, at most `ob_search_bars`, to the last down-close candle. Its
full range becomes the zone. Mirror for bearish.

*Rejected:* requiring a fair value gap in the impulse leg (cuts signal count too hard for a
first run — wired as `require_fvg`, default off); taking the extreme candle of the
consolidation (needs "the consolidation" defined, a parameter with no obvious right value).

**Entry is the first touch of the zone's near edge.** The detector holds live zones and
emits on the bar whose range trades into the near edge.

*Rejected:* waiting for a close back in the trend direction, or for the 50% midpoint. Both
are better filters and both are worth testing later; neither is the canonical baseline.

## The engine constrains this

**There are no resting limit orders.** `fill_entry` fills at the *next bar's open* at market
(`sim.rs`), and `signal.entry` is never used as a fill price — it only feeds
`is_coherent()`. Risk is then measured from the actual fill (`runner.rs`), so sizing stays
honest even though entry and fill differ.

So "rest a limit at the order block" is not expressible. The detector waits, emits on the
touch bar, and the fill lands one bar later at market. That is worse than a limit fill at
the zone edge, and it is the truthful version of what this engine can do.

`Signal::expires_after` was declared and consumed nowhere. It has been deleted; zone expiry
is detector state.

## Signal

| Field | Value |
|---|---|
| `entry` | the touch bar's close — closest knowable proxy for the next-bar-open fill |
| `stop_loss` | far edge ∓ `max(atr_buffer × ATR(14), min_buffer_points × point_size)` |
| `take_profit` | `entry ± target_r × risk_distance` |
| `detail` | `zone_high`, `zone_low`, `bos_price`, `trend_dir`, `zone_age_bars`, `fvg_present` |

If the touch bar closes beyond where the stop would sit — price sliced clean through the
zone — the setup is skipped explicitly and counted, rather than emitted for
`is_coherent()` to drop silently at `runner.rs`. A filter you cannot count is a filter you
cannot reason about.

Fixed R targets rather than "next opposing structure", on purpose: win rate then maps
directly to expectancy, the R-multiple histogram in Meridian becomes meaningful, and the
result measures detection instead of confounding it with exit logic.

## Parameters

| Param | Default | Note |
|---|---|---|
| `swing_lookback` | 5 | bars each side of a fractal swing |
| `ob_search_bars` | 20 | cap on the walk-back; bounds per-bar cost |
| `zone_max_age` | 50 | bars before a zone expires |
| `max_live_zones` | 8 | ring capacity per direction |
| `atr_buffer` | 0.25 | × ATR(14) beyond the far edge |
| `min_buffer_points` | 20 | floor, so the stop clears the spread |
| `target_r` | 2.0 | fixed R target |
| `require_fvg` | false | deferred filter, wired but off |
| `warmup` | 200 | bars |

## Zone lifecycle

A zone leaves the book on the first of:

- **Touched** — bullish: `bar.low <= zone_high`. Bearish: `bar.high >= zone_low`. Emits,
  then the zone is consumed. One shot.
- **Invalidated** — a bar *closes* beyond the far edge. The zone did not hold.
- **Expired** — `zone_max_age` bars elapsed.
- **Evicted** — the book is fixed-capacity; the oldest drops when full, keeping the
  detector allocation-free per the `Detector` contract.

Only zones matching current trend direction are eligible.

## Structure

Three units, following the house pattern in `rolling.rs` — small types with one job,
composed by the caller.

- `engine/structure.rs` — `SwingTracker` (fixed ring, emits confirmed swings with the
  correct lag) and `ZoneBook` (fixed-capacity zone lifecycle). Neither knows about a
  strategy, so the next one gets them free.
- `engine/strategies/smc.rs` — `SmcDetector` and its factory, composing `SwingTracker`,
  `ZoneBook` and `Atr`, holding trend state.
- Registered in the registry so `/detectors` stops returning `[]`.

*Rejected:* a generic zone framework covering order blocks, fair value gaps and breakers.
One strategy does not justify the abstraction.

## Tests — `tests/smc.rs`

- Synthetic bars with a hand-built break and order block: exactly one signal, at the
  expected bar, with the expected zone bounds and stop.
- Swing confirmation lag: a swing at `i` is not actionable before `i + swing_lookback`.
- Zone invalidation, expiry and one-shot consumption each fire.
- A zone counter to structure emits nothing.
- A bar slicing through the whole zone does not produce an incoherent signal.

## Known, accepted

`max_open_per_symbol` is 3, so a fourth concurrent signal on a pair is dropped rather than
queued. Expect fewer trades than signals. At the default 1% risk that is up to 3% of equity
exposed per symbol.

Rule 6 applies: this detector carries a version, and changing any rule above bumps it.
Backtests from different versions are not comparable.
