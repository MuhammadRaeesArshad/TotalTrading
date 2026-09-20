# Cells, sweeps and global filters

20 Sep 2026 · **Status: approved, in progress**

A redesign of what a backtest *is*, so that: results are never recomputed when
they already exist, a whole strategy can be explored with one button, and every
question you can ask of a finished result is a filter rather than another run.

This document is the plan. A session picking this up mid-way should read it,
check the progress list at the bottom, and continue.

## The one idea

**A backtest result is one pair, sealed.**

```
cell = (detector, detectorVersion, params, symbol, timeframe + higher,
        fromTs, toTs, costs, engineVersion)
```

Everything else follows from it:

- **Deduplication** — a cell is a pure function of its inputs, so hash them.
  Same hash, same answer: return the stored one and run nothing.
- **Sweeps** — a sweep is just a list of cells. Nothing new has to exist.
- **Combining afterwards** — R-multiples and per-pair equity are additive, so
  any subset of cells can be composed into one view, at read time, as often as
  you like with different subsets.

### Why per-pair, and what it costs

Under a **shared** account the pairs are not independent: a loss on one shrinks
the next position on another. That is what made AUDNZD read profitably in a
28-pair run and badly alone. Shared-account results therefore **cannot** be
decomposed into pairs, and 28 of them cannot be recombined into a subset.

So a cell is per-pair capital by definition. A true shared-account run is still
available and still meaningful — it is simply its own run, produced in one go,
and it does not participate in combining. The UI must not offer to combine one.

## A simplification found while building

**Per-pair *capital* is what gives independence, not per-pair *documents*.**
Every trade already carries its symbol, so "how did EURUSD do" is a read-time
filter over a multi-pair result — no separate document per pair is needed to
combine or separate them afterwards. That collapses step 1b entirely and keeps
a sweep at 9 × 5 runs rather than 9 × 5 × 28.

The rule that matters is unchanged: only a run made with **per-pair capital**
can have its pairs pulled apart or recombined, because a shared account makes
them interdependent.

## 1. Cells and deduplication

`backtests` keeps holding one document per result; a document now covers **one
symbol**. New fields:

| field | why |
|---|---|
| `fingerprint` | The hash above. Indexed with `userId`. |
| `batchId` | Groups cells launched together. Null for a one-off. |
| `batchLabel` | What the batch was for, e.g. `trend_engulf · sensitivity`. |
| `sweepAxis`, `sweepValue` | Which setting this cell varies, and to what. Null outside a sweep. |

On start: compute the fingerprint, look for a **completed** cell with it, and
return that instead of running. A failed or cancelled cell does not count as an
answer and is re-run.

**`engineVersion` is in the fingerprint.** A change to fills, costs or exits
changes results without touching a detector's version, and reusing a cell
across that would be silently wrong. This puts an obligation on us:

> Changing simulation semantics bumps the engine crate version.

That goes in `CLAUDE.md` alongside rule 6, because the cache is only as honest
as that rule.

## 2. Sweeps — one setting at a time

A sweep takes a strategy, a base set of parameters, a pair set and a window,
and produces cells that vary **one setting at a time** with the rest at their
defaults.

Values come from the setting's own `min`, `max` and `step` in
`params_schema` — the bounds are already declared there, which is what the New
backtest form renders. `choice` settings sweep their options; `bool` settings
sweep both states.

```
cells = Σ over settings ( values(setting) ) × pairs
```

For `trend_engulf`: 9 settings × ~5 values × 28 pairs ≈ 1,260 cells, of which
the base configuration repeats 9 times and is computed once. That is the point
of doing dedup first.

Why one-at-a-time rather than a grid: a full grid over 9 settings is 19,683
combinations before pairs, and it answers a question nobody asked. One at a
time answers the one that matters — *which knobs move the result, and where
does it fall apart* — and it stays legible on a chart.

**No model is involved.** Bounds are declared in the strategy. An LLM proposing
tighter ranges is a possible later addition, and by rule 9 it can never become
a step in producing a result.

## 3. Global filters, replacing per-tab ones

Today each tab filters its own way, and the Anatomy tab keeps private state
that the other tabs know nothing about. That is why answering "how did London
do" means re-reading four screens.

Instead: **one filter bar above the tabs**, owned by the page.

- pairs (multi-select)
- date range
- sessions (multi-select)
- direction, exit reason
- R range

Every tab renders the filtered trade set, and every statistic recomputes from
it — `summarize()` already takes trades and a starting balance, so this is
composition rather than new maths. The starting balance for a filtered view is
`initialBalance × (pairs selected)`, which is exactly `deployedCapital` already
generalised.

The filter belongs in the URL, so a filtered view is a link.

## 4. The batch page

A batch of cells needs its own view: every cell in it, the swept setting on one
axis and the result on the other, and the same global filter bar applied across
all of them. Selecting cells composes them into one combined result.

## Order of work

1. **Cells + fingerprint dedup.** Foundational; everything else assumes it.
2. **Global filters** on the single-result page.
3. **Sweep launch** + progress.
4. **Batch page** and combining.

## Decisions already taken

- **One setting at a time**, not a grid (the user's call, 20 Sep).
- **Existing runs are deleted**, not migrated (the user's call, 20 Sep). They
  are a different kind of object and two of the three strategies have moved
  version since. Deletion goes through the UI's own bulk delete, so the gateway
  stays the only Mongo writer.

## Progress

- [x] Design agreed
- [x] 1a · fingerprint + dedup on the existing one-run shape
- [x] 1b · dropped — per-pair capital plus read-time filtering does the job
- [x] 2 · global filters — one bar above the tabs, in the URL, every tab and
      every statistic recomputing from what survives
- [x] 3 · sweep launch — `POST /backtest/sweeps`, a queue that runs one cell
      at a time, and `/sweeps/:id` showing every axis
- [ ] 3b · a chart per axis instead of a table
- [ ] 4 · batch page
