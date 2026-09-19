# Strategy (draft): multi-timeframe SMC — the user's own

**Date:** 2026-09-19
**Status:** DRAFT — captured from conversation, not approved. Do not implement until the
open questions below are answered. `smc_ob` (single timeframe) is the pipeline test; this
is the strategy it leads to.

## As described by the user

- **Trend filter on 4H and 1H.** Each is bullish or bearish. Trades are taken only in
  that direction.
- **Structure on 30m and 15m.** Look for a break of structure in the direction of the
  higher-timeframe trend.
- **Entry at the order block that forms the next swing.** Bearish example: higher high →
  lower low (the break down) → price retraces to where the next lower high should form;
  the trade is taken at the order block there. Bullish mirrors it.

The description was cut off after "which would be an orderblock" — there may be more.

## Open questions

1. If 4H and 1H disagree, is that no trade?
2. Is 4H/1H trend defined the same way as `smc_ob` — direction of the last swing break?
3. 30m and 15m: break required on both, on either, or 30m for structure and 15m for entry?
4. Is the order block the last opposing candle before the leg that made the lower low
   (bearish) / higher high (bullish)?
5. Stop: beyond the higher high, or beyond the order block? Target: next lower low, or a
   fixed R?
6. Entry trigger: first touch of the order block (as `smc_ob`), or a confirmation?

## Fits the engine as it stands

- Base timeframe 15m; 30m, 1H and 4H passed as higher timeframes. `BarCtx::higher()`
  already gives closed higher-timeframe bars only, so no lookahead across timeframes.
- `SwingTracker` and `ZoneBook` in `structure.rs` run per timeframe unchanged.

## What the results UI must show for it

Per-trade quality, not only totals:

- Each condition with its measured value — 4H trend, 1H trend, alignment, where the
  30m/15m break happened, whether the HH → LL → LH sequence is clean.
- Order block quality — size against ATR, fresh or already touched, age, fair value gap.
- Maximum adverse and favourable excursion before exit, to judge entry timing.
- A confluence grade (A/B/C), and a comparison of results by grade — the test of whether
  quality pays.
- Four stacked timeframe charts (4H, 1H, 30m, 15m) with the trade marked on each.

Needs the signal `detail` map carried onto each `Trade`, and MAE/MFE computed in the
simulator.
