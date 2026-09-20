# Strategy: multi-timeframe SMC (`smc_mtf`)

**Date:** 2026-09-20 · **Status:** approved and implemented · v1

The user's own strategy, in their words: trend on 4H and 1H, take trades only in
that direction; look for a break of structure on 30m and 15m in that direction;
a higher high into a lower low into what should be the next lower high is the
entry, at the order block.

## Rules

1. **Direction.** H4 and H1 each have a trend: the direction of the last swing
   break of structure on that timeframe. How they combine is a setting
   (`trend_mode`), because it differs per pair:
   `both_agree` (default), `h4_only`, `h1_only`, `either` (a conflict is still
   no trade). No direction means no trades.
2. **Setup.** A break of structure on M15 **or** M30, in that direction.
   `entry_on_m30` turns the M30 half off.
3. **Entry.** The order block behind the break — the last opposing candle before
   the impulse, which is where the next lower high (bearish) should form. Filled
   on the first touch, at the next bar's open, as the engine always fills.
4. **Exit.** Stop beyond the block's far edge by `atr_buffer` × ATR; take profit
   at `target_r` × risk. Fixed R keeps win rate and expectancy comparable.

Zones expire after `zone_max_age` bars, die on a close beyond their far edge,
and fire once. A bar that slices through the block and closes past the stop is
skipped and counted, never entered.

## Timeframes

Runs on **M15**, reading **M30, H1, H4**. All four must be imported; the New
backtest form refuses to start without them. Higher timeframes are read through
`BarCtx::higher`, which only ever exposes *closed* bars (rule 4).

## Settings are per strategy

Each strategy declares its own description, timeframes and settings through
`DetectorFactory`, and `GET /detectors` serves them. The form builds itself from
that, so a new strategy needs no UI change. Settings are frozen onto the run
(`rulesSnapshot`) so a result can always be traced to what produced it.

Unknown or malformed settings are refused at the start of a run, not ignored: a
misspelled parameter must never quietly run different rules.

## Metrics stay common

Every strategy produces trades with an entry, stop and target, so net, win rate,
profit factor, expectancy in R, drawdown, MAE and MFE mean the same thing for
all of them and stay comparable. Only the settings and the per-trade "why it
fired" detail are strategy-specific.

## Open

- Not yet run on real history; no claim is made about whether it works.
- `trend_mode` is per run, not yet per pair within a run.
