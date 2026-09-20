# Trend + Engulfing — `trend_engulf`

20 Sep 2026. Ported from the user's `finance-trader-backend`
(`backend/strategies/trend_engulfing.py`, `backend/helpers/trend_detector.py`,
`backend/helpers/engulfing_candle.py`), which they ran and judged good.

The rules below are taken from that **code**, not its docstrings — two of them
disagree, and the code is what produced the results. Where the port deviates it
says so, and why.

## The setup

Trade only with the higher timeframe's trend, and only on a full engulfing
candle in that direction, and only when price has actually been going
somewhere.

1. **Direction** — read from one timeframe above, by EMA slope.
2. **Trigger** — a bullish engulfing candle in an uptrend, bearish in a
   downtrend.
3. **Filter** — reject when the last 20 bars went nowhere.
4. **Exit** — a stop just past the engulfing candle's extreme, target at a
   fixed R.

## 1. Direction — EMA slope, normalised by ATR

On the trend timeframe, per closed bar:

```
ema   = EMA(close, ema_period)          # SMA-seeded, alpha = 2/(period+1)
atr   = ATR(14)                         # Wilder
score = (ema[i] - ema[i - slope_window]) / atr[i]

score >  atr_threshold   →  UPTREND
score < -atr_threshold   →  DOWNTREND
otherwise                →  CONSOLIDATION  (no trades)
```

Defaults: `ema_period` 21, `slope_window` 5, `atr_threshold` 0.5.

Only the last **closed** trend bar counts, which is what `BarCtx::higher` gives
— the original did the same with `searchsorted(..., side='right') - 1`.

## 2. Trigger — engulfing, wicks included

With `prev` the previous base bar and `curr` the current one:

```
full engulf   : curr.low < prev.low  AND  curr.high > prev.high
bullish       : prev closed down, curr.close > prev.high, curr.close > curr.open
bearish       : prev closed up,   curr.close < prev.low,  curr.close < curr.open
not a doji    : |curr.close - curr.open| ≥ min_body_atr × ATR(14) on the base TF
```

`min_body_atr` defaults to 0.5.

## 3. Filter — the last 20 bars went somewhere

```
|close - close[20 bars ago]| ≥ 100 pips
```

Pip size is the original's heuristic: `0.01` when price is above 10 (the JPY
crosses), `0.0001` otherwise. Defaults: `consolidation_lookback` 20,
`consolidation_pips` 100.

## 4. Trade

```
LONG   entry = close of the engulfing candle
       stop  = engulfing low  − sl_pips × pip_size
       target = entry + risk_reward × (entry − stop)

SHORT  entry = close of the engulfing candle
       stop  = engulfing high + sl_pips × pip_size
       target = entry − risk_reward × (stop − entry)
```

Defaults: `sl_pips` 5, `risk_reward` 2.

## Where this port deviates, and why

**The stop is a pip buffer, not an ATR multiple.** The Python docstring says
`low − atr_multiplier × ATR` with a default of 1.5, but the code it sits on top
of uses `low − sl_pips × pip_size` with a default of 5 pips. The code is what
ran, so the code is what is ported. *This is worth confirming* — 5 pips and
1.5 ATR are very different stops, and which one produced the results the user
liked decides whether this is right.

**Entry fills at the next bar's open, not at the engulfing close.** The
original entered at the signal bar's close. That close is not tradeable until
the bar has ended, so this engine fills the bar after (rule 4, no lookahead).
Expect worse numbers here than in the Python backtest; the difference is the
lookahead being removed, not a change to the rules.

**No free pass when ATR is cold.** The original treated an unavailable ATR as
"body is fine". Here the detector waits for warmup instead, so a signal never
skips the doji filter (rule 5, costs and ambiguity resolve against the
strategy).

**Position sizing is the engine's, not the strategy's.** The original computed
a lot size from `risk_per_trade / (risk_pips × 10)`. Sizing belongs to the
simulator here, which risks a configured percent of *current* equity and
compounds — so those three parameters are dropped.

## Timeframes

The original derived the trend timeframe from the base one: M1/M5/M15 → H1,
M30/H1 → H4, H4 → D1, D1 → W1. A `DetectorFactory` declares its timeframes
statically and cannot read a parameter to decide, so this port runs on **M15**
and makes the trend timeframe a choice of **H1** (the original's mapping) or
**H4**. Both are loaded; the unused one costs a mapped file and nothing else.

## Version

`trend_engulf` v1. Changing any rule above bumps it (rule 6).
