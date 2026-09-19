# Backtest results page

**Date:** 2026-09-19
**Status:** layout approved by the user; build order below. Mockup of the four analysis
views: https://claude.ai/artifact/1ySke2wL5kMpm5PMFW8UGC (sample data).

## What the user asked for

"Stats globally, I can see all trades, and clicking one shows the graph near it so I can
see how the trade was executed." Plus all four analysis views from the mockup, and
specifically Net R by pair, win rate by session, and Net R by month.

## Layout

One page per run: `/backtests/:runId`.

```
┌ run header — detector + version, pairs, timeframe, window, sizing, intrabar policy ┐
├ global stats strip — net, trades, win rate, profit factor, expectancy, max DD     ┤
├ tabs:  Trades (default) · Verdict · Ledger · Replay · Anatomy                     ┤
│                                                                                    │
│  Trades tab — master / detail                                                      │
│  ┌ trade list (sortable, filterable) ┐ ┌ selected trade — sticky panel ┐          │
│  │ # date pair side session R net    │ │ price chart around the trade   │          │
│  │ ...                               │ │ zone, break, fill, stop, target│          │
│  │ ▸ selected row                    │ │ quality card + signal detail   │          │
│  └───────────────────────────────────┘ └────────────────────────────────┘          │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **Desktop:** chart panel sits to the right of the list and stays in view while the list
  scrolls. Selecting a row swaps the panel; arrow keys move between trades.
- **Phone:** the chart expands inline beneath the selected row.
- The selected trade is in the URL (`?trade=42`) so a trade can be linked and reloaded.
- Every other tab's trade rows open the same panel.

## Tabs

| Tab | Question | Content |
|---|---|---|
| Trades | How was each trade taken? | List + adjacent chart + quality card |
| Verdict | Did it pass my criteria? | Scorecard against criteria saved per strategy |
| Ledger | How was each metric made? | Metric → formula with real numbers → contributing trades |
| Replay | When did it make and lose money? | Equity curve + drawdown underlay, drag to scope |
| Anatomy | Where does the edge live? | R histogram, win rate by session, Net R by pair, Net R by month — cross-filtering |

## Trade panel

- Chart: bars around the trade from the bar cache. Order-block zone, the broken swing,
  touch bar, fill on the next bar's open, stop, target, exit.
- Quality card: every condition the detector reports in `detail`, with its value. Generic
  over detectors — the panel renders whatever keys the detector emits, so a new strategy
  needs no UI change.
- Excursion: maximum adverse and favourable excursion in R, to judge entry timing.

## Colour rules (Meridian)

Green and red mean money only. Pass/fail is filled vs struck-hollow marks; candles are
grey (hollow up, filled down); wins are filled shapes, losses hollow, so nothing depends
on colour alone.

## Build order

1. **Engine** — detector tests; carry `Signal.detail` onto `Trade`; MAE/MFE in the
   simulator; an engine route returning bars around a trade.
2. **Data** — import history, run the first real backtest.
3. **Gateway** — persist runs and trades; endpoints for run, trades, trade bars; criteria
   in `strategy_configs`. *Needs approval: adds `detail`, `mae_r`, `mfe_r` to the trades
   schema.*
4. **Meridian** — Trades tab first (it is the page), then Verdict, Ledger, Replay, Anatomy.

## Derived on the client, not stored

Session (from entry time, UTC hours: Asia 0–7, London 7–12, overlap 12–16, New York
16–21, late 21–24), calendar month, per-pair and per-session aggregates. All recomputed
from the trade list, so there is one source of truth.
