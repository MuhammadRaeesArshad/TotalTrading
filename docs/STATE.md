# Where things stand

Updated 20 Sep 2026. Read this after `CLAUDE.md` — that one holds the rules,
this one holds the situation. Keep it current when you finish a piece of work:
a stale handoff is worse than none.

## What works

- **Auth, MT5 accounts, history import.** Imports run as background jobs with
  live progress, and are incremental — only bars the cache lacks are fetched.
  Cached as of 20 Sep 2026: 28 pairs × M15, M30, H1, H4, D1 — 140 series, so
  both strategies have everything they read.
- **Two strategies.** `smc_ob` (single timeframe, a test of the pipeline) and
  `smc_mtf` (the user's own: H4+H1 direction, M15/M30 break of structure, order
  block entry). Each declares its own description, timeframes and settings;
  the New backtest form builds itself from that.
- **Two capital modes.** A run either shares one balance across every pair
  (what a live account is, and the default) or gives each pair its own copy of
  it. Per-pair isolates a pair's edge from what the others were doing, which
  is what made a 28-pair run and a solo run of the same pair disagree.
- **Three strategies.** `smc_ob`, `smc_mtf` (**v2**), and `trend_engulf` — the
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
- **Backtests end to end.** Run through the gateway, stored in Mongo with every
  trade, and shown at `/backtests/:id`: global stats, every trade with its chart
  and the detector's reasoning beside it, plus Verdict, Ledger, Replay and
  Anatomy tabs.
- **`ai-analysis`.** Wraps local Ollama; takes computed figures, returns prose.
  Optional by rule 9 — everything works with it switched off.

## Not built

- **Live scanning.** The engine can do it (same `Detector`), nothing drives it.
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

**It needs the account reconnected first.** Instruments are classified when an
account connects — "the one place symbols enter the system" — so the 6 XAU rows
already in Mongo still carry the old `instrumentClass: 'other'` and stay hidden
until a reconnect re-derives it. Press **Connect** on the Accounts page (MT5
must be running), then import, then it appears in the New backtest picker,
which lists what is cached rather than what exists.

**Its history still has to be imported**, and `trend_engulf` will mostly skip
it until its pip-denominated settings are revisited: on gold a "pip" is 0.01,
so `sl_pips` 5 is a $0.05 stop that the cost floor rejects, and
`consolidation_pips` 100 is a $1 move that gold clears constantly. Those
defaults were tuned for FX. Changing them per instrument changes what a rule
means, so it needs a decision rather than a guess.

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
  against criteria written for `smc_ob`.
- **The engine guesses point size; the gateway already knows it.** Every
  instrument row carries the broker's real `pointSize`, `contractSize` and
  `volumeMin`, but `engine-service/src/instruments.rs` re-derives its own from
  the symbol name. They agree today, including on gold. They will not agree
  forever. The honest fix is the gateway sending per-symbol sim values with the
  run request, and its own module doc has said so since it was written.

## Open decisions

- **Stop a run when the account is blown?** (Per-pair capital narrows this but
  does not answer it — a single pair can still blow its own book.) At high risk settings the balance
  hits zero early and every later signal is skipped for being below the minimum
  lot, while the metrics still read as though it traded on. Proposed: stop the
  run, mark it "account blown" with the date. Not built — it changes what a
  stored backtest means, so it needs the user's yes.
- **`trend_mode` per pair**, rather than per run, for `smc_mtf`.
- **`trend_engulf`'s stop: 5 pips or 1.5 ATR?** The Python original's docstring
  says one and its code does the other. The code is ported, since the code is
  what ran — but which produced the results worth keeping is the user's call.

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
