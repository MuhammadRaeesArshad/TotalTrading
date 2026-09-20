# Where things stand

Updated 20 Sep 2026 (frontend pass + calculation audit). Read this after `CLAUDE.md` — that one holds the rules,
this one holds the situation. Keep it current when you finish a piece of work:
a stale handoff is worse than none.

## What works

- **Auth, MT5 accounts, history import.** Imports run as background jobs with
  live progress, and are incremental — only bars the cache lacks are fetched.
  Cached as of 20 Sep 2026: 145 series across 29 pairs on M15, M30, H1, H4 and
  D1, so every strategy has what it reads. The Jobs page shows imports running
  and finished; Summary shows the coverage.
- **Two strategies.** `smc_ob` (single timeframe, a test of the pipeline) and
  `smc_mtf` (the user's own: H4+H1 direction, M15/M30 break of structure, order
  block entry). Each declares its own description, timeframes and settings;
  the New backtest form builds itself from that.
- **Two capital modes.** A run either shares one balance across every pair
  (what a live account is, and the default) or gives each pair its own copy of
  it. Per-pair isolates a pair's edge from what the others were doing — but
  **only under `sizing: compound`**. Under the `fixed` default the two modes
  produce identical trades and differ only in what percentages are measured
  against. See the audit section below.
- **Three strategies.** `smc_ob` (v1), `smc_mtf` (**v3**), and `trend_engulf` (v1) — the
  last ported from the user's earlier `finance-trader-backend` (the local copy
  is at D:\raees), where the EMA-slope trend detector and the engulfing
  entry had already proved out. Both multi-timeframe strategies now read
  direction from the same `TrendMeter` in `structure.rs` — one implementation
  of what "uptrend" means, not two.
- **`smc_mtf` v1 results are dead.** v2 changed how H4 and H1 decide
  direction, from the last break of structure to the EMA slope. Stored runs
  keep the version that produced them; do not compare across them (rule 6).
- **Runs can be archived or deleted.** Two lists, Current and Archived;
  archiving only moves a run aside and keeps every trade. Deleting removes the
  run and its trades for good and asks first.
- **One filter for the whole report.** Pairs and sessions multi-select, side,
  result and a date range, above the tabs and in the URL. Trades, Verdict,
  Ledger, Replay and Anatomy all recompute from what survives, including the
  starting capital — narrowing a per-pair run to three pairs measures against
  three balances, not twenty-nine.
- **Explore.** One page over every run at once: group trades by setting,
  pair, session, year, month or side, with a floor on how many trades a slice
  needs before it counts. Answers "in which session, on which pair, over four
  years, did this make money" without opening runs one at a time.
- **The nav is no longer mostly placeholders.** Summary, Strategies and Jobs
  are real pages, built entirely from endpoints that already existed. Their
  stubs had claimed they were blocked on a strategy definition and a Redis job
  queue — both had been built since, so the pages were describing a system
  that no longer matched the one underneath them.
- **Backtests end to end.** Run through the gateway, stored in Mongo with every
  trade, and shown at `/backtests/:id`: global stats, every trade with its chart
  and the detector's reasoning beside it, plus Verdict, Ledger, Replay and
  Anatomy tabs.
- **Strategies.** Every registered strategy, its version, the timeframes it
  reads and a table of every setting it declares, with defaults and ranges.
  Read from `GET /backtest/detectors` — the same schema the New backtest form
  builds itself from — so a fourth strategy appears the moment its factory is
  registered, with nothing written per strategy.
- **Jobs.** Running imports, runs and sweeps with progress, plus finished
  imports and failed runs. Polls while anything is live and stops when nothing
  is. A sweep can be cancelled from here, which previously meant finding the
  page that started it.
- **Summary.** Cache coverage, completed-run totals, the best expectancy found
  so far, and each service's reachability. Deliberately not "live performance":
  nothing scans and execution is off, so open P&L is a number that cannot
  exist yet.
- **`ai-analysis`.** Wraps local Ollama; takes computed figures, returns prose.
  Optional by rule 9 — everything works with it switched off. **Not reachable
  from the UI**: the gateway holds only a health probe, with no route through
  to its `POST /analyze`.

## Not built

- **Live scanning.** The engine can do it (same `Detector`), nothing drives it.
- **Positions, Journal, System logs, AI analysis** — the four pages still on
  `ComingSoon`, and each is genuinely blocked, not merely unbuilt. Positions
  needs `/positions` and `/history` on the connector, which serves only
  `/account`, `/symbols` and `/candles`. Journal needs MT5 history
  reconciliation and somewhere to keep a note. System logs needs something to
  write the `system_logs` collection, which nothing does. AI analysis needs one
  gateway route and somewhere to keep what comes back. Each stub now says
  exactly that — check the claim before adding to that file.
- **Order execution.** Off, and staying off (rule 8).
- **`packages/contracts`.** Documented in `CLAUDE.md`, deliberately not created;
  needs npm workspaces, which changes every service Dockerfile.
- **Per-strategy Verdict criteria.** Thresholds are defaults in
  `apps/web/src/features/backtests/stats.ts`, not yet saved per strategy.

## XAUUSD

Gold is now synced and priced: it was rejected by the gateway's pair filter
(XAU is not a currency), and the engine would have given it a 5-decimal FX
point size — a thousand times too small, which sizes every gold position a
thousand times too large.

**Its history is imported.** As of 20 Sep the cache holds XAUUSD on all five
timeframes — 29 pairs × 5 = 145 series — so it is in the New backtest picker,
which lists what is cached rather than what exists. (If it ever disappears
from the picker again, the cause is instrument classification: symbols are
classified when an account connects, so stale `instrumentClass: 'other'` rows
stay hidden until a reconnect re-derives them.)

**`trend_engulf` will still mostly skip it** until its pip-denominated settings
are revisited: on gold a "pip" is 0.01, so `sl_pips` 5 is a $0.05 stop that the
cost floor rejects, and
`consolidation_pips` 100 is a $1 move that gold clears constantly. Those
defaults were tuned for FX. Changing them per instrument changes what a rule
means, so it needs a decision rather than a guess.

## Costs a backtest charges

Spread (per bar, plus any extra set), slippage, round-turn commission, and
**overnight financing**. Swap is charged per night held, triple on Wednesday
because spot settles two business days out, and never on Saturday or Sunday
when there is no rollover.

The rates are the broker's own — `swap_long` and `swap_short` from the
terminal, stored per instrument and sent to the engine with the run. There is
no guessing a carry rate, so a symbol whose rates are not stored is financed at
zero and the trade panel says "none charged" rather than letting it pass as
free. **Reconnect the account** to fetch them.

The same channel now carries the broker's real point size, contract size and
volume steps, which the engine previously guessed from the symbol's name.

## Thin spots

Known, and none of them are covered by a test:

- **The `capital` field was hand-typed into five files across three languages**
  — engine, gateway DTO, gateway schema, gateway client, web types. Nothing
  checks that they agree. This is exactly the drift `packages/contracts` exists
  to stop, and the argument for building it just got stronger.
- **Per-pair capital has never been run through the real UI**, only through the
  engine's own tests. The results page now measures it against the deployed
  total rather than one pair's balance, which was wrong by the pair count.
- **Docker serves the built web bundle**, so a UI change is invisible until
  `docker compose -f infra/docker/docker-compose.yml build web && … up -d web`.
  Same for the gateway. Easy hour to lose.
- **Verdict thresholds are global**, not per strategy, so `smc_mtf` is judged
  against criteria written for `smc_ob`. They are now applied to the filtered
  trades, so a narrowed view is judged on its own sample — and a narrow one
  will fail the 100-trade criterion, which is the criterion doing its job.
- **Swap is zero until the account is reconnected.** The rates are stored on
  instrument sync, and instruments synced before this existed have none.

## From the 20 Sep audit

Two were fixed, with a test shown failing against the old code first. The rest
are recorded rather than changed, because each needs a decision.

**Fixed.**

- **Max drawdown percent was the percentage at the largest *currency* fall**,
  not the largest percentage fall. The two need not coincide: a 20% dip early
  on a small balance is worse than a bigger dollar dip later against a much
  higher peak, and only the latter was ever reported. Now tracked
  independently. **Engine crate went to 0.3.0** (rule 6), so runs stored before
  this carry `engineVersion` 0.2.0, hold the old figure, and are not reused for
  a new request.
- **The Verdict tab ignored the page filter** for four of its nine criteria.
  Trade count, profit factor, expectancy and drawdown read `run.metrics` —
  which describes the whole run and exists on every completed one — so
  narrowing to London judged all 1,240 trades while the Trades tab beside it
  showed 87. The run is no longer a parameter of `verdict()` at all, so the
  unfiltered figures are unreachable rather than merely unused.
- **The equity curve's closing point carried the previous sample's timestamp.**
  On a run long enough to be sampled, the last point sat at the wrong time.

**Found, not changed — each needs a decision.**

- **`capital` is close to cosmetic now that `sizing` defaults to `fixed`.**
  Under `fixed`, position size is a percent of `initial_balance` whatever book
  the task draws on, so `shared` and `per_symbol` produce *identical trades*.
  All that differs is the denominator metrics are measured against — final
  equity and drawdown percent. The isolation the mode was built for only
  happens under `compound`. The description at the top of this file was written
  when `compound` was the only mode and now overstates it.
- **`EndOfData` exits pay no costs.** Positions still open at the end close at
  the last bar's close with no spread or slippage, unlike every other exit, and
  nothing counts how many trades that was. Rule 5 says costs are pessimistic by
  default; this is the one exit that isn't. The count is derivable per trade
  (`exitReason`) but appears in no metric.
- **`max_open_per_symbol` is enforced per task, not per symbol.** Not reachable
  today — a request carries one base timeframe, so one task per symbol — but
  the name promises something the code would not deliver if that changed.
- **`deployedCapital` counts `run.symbols.length`; the engine counts symbols
  that produced tasks.** A symbol requested but with no cached bars makes the
  UI's denominator larger than the engine's, and every percentage on the page
  correspondingly smaller.
- **Session buckets are fixed UTC hours.** London is UTC+0 in winter and UTC+1
  in summer, so for part of the year the London and Overlap buckets are an hour
  off from the session they name. A deliberate simplification, but an undocumented
  one, and session is a dimension Explore groups by.
- **`cost_offset`'s docstring says "half-spread"; it applies the full spread.**
  The total is right — bars are bid, so a full spread on entry and none on a
  limit-order take profit is the correct round turn — but the comment describes
  something the code does not do.

## Settled, 20 Sep

- **The account no longer runs out.** `sizing` defaults to `fixed`: risk is a
  percent of the *starting* balance, so a losing stretch cannot wipe the
  account out and silently stop the run answering. `compound` is still there
  for asking whether a size is survivable. Engine crate went to 0.2.0, which
  the fingerprint requires (see rule 6).
- **`trend_engulf`'s stop stays 5 pips** — the code, not the docstring. The
  user's call: follow the code.
- **`trend_mode` can be set per pair** for `smc_mtf` (v3). Pairs left alone use
  the run's setting.
- **The old backtests were deleted** by the user.

## Open decisions

None outstanding.

## Running it

```bash
docker compose -f infra/docker/docker-compose.yml up -d     # six services
bash scripts/verify.sh                                      # every test, ~2 min
```

Meridian is at http://localhost:8080. The engine is on 8004, the gateway on
4000, `ai-analysis` on 8003.

**The MT5 connector is not in Docker** and must be started by hand, with the
terminal open and logged in:

```bash
cd services/mt5-connector && .venv/Scripts/python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8001
```

## Gotchas on this machine

- **Native Rust does not run here.** `rustc.exe` exits `0xC0E90002` loading its
  driver DLL — likely Defender or an app-control policy. Build and test through
  Docker (`scripts/verify.sh` already does).
- **Git Bash rewrites Unix-looking paths** in `docker run` arguments. Prefix
  with `MSYS_NO_PATHCONV=1` when passing container paths.
- **The connector serialises on one lock.** While an import runs, its `/health`
  blocks too. That is the terminal being busy, not a hang.
- **The venv is Python 3.12.** The pinned `MetaTrader5` and `pydantic` have no
  wheels for 3.13+.
- **First import of a pair is slow** (minutes): MT5 downloads years of minute
  data from the broker. Later imports top up in seconds.

## Verifying before you claim anything

`bash scripts/verify.sh` — the architecture rules, 78 Rust tests, 16 gateway,
13 ai-analysis, the web build and its stats self-check. A regression test must
be shown to fail against the old code before it counts (`CLAUDE.md`).

`scripts/checks/rules.sh` is the first step and the one worth knowing about: it
greps for the rules that a tired session breaks quietly — a second `Detector`,
`MetaTrader5` outside the connector, a second Mongo writer, `order_send`
anywhere, the engine gaining a way to reach `ai-analysis`. Each case has been
shown to fail when the rule is actually broken.
