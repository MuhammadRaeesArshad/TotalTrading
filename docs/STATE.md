# Where things stand

Updated 20 Sep 2026. Read this after `CLAUDE.md` — that one holds the rules,
this one holds the situation. Keep it current when you finish a piece of work:
a stale handoff is worse than none.

## What works

- **Auth, MT5 accounts, history import.** Imports run as background jobs with
  live progress, and are incremental — only bars the cache lacks are fetched.
- **Two strategies.** `smc_ob` (single timeframe, a test of the pipeline) and
  `smc_mtf` (the user's own: H4+H1 direction, M15/M30 break of structure, order
  block entry). Each declares its own description, timeframes and settings;
  the New backtest form builds itself from that.
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

## Open decisions

- **Stop a run when the account is blown?** At high risk settings the balance
  hits zero early and every later signal is skipped for being below the minimum
  lot, while the metrics still read as though it traded on. Proposed: stop the
  run, mark it "account blown" with the date. Not built — it changes what a
  stored backtest means, so it needs the user's yes.
- **`trend_mode` per pair**, rather than per run, for `smc_mtf`.

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

`bash scripts/verify.sh` — 106 checks: 77 Rust, 16 gateway, 13 ai-analysis, the
web build and its stats self-check. A regression test must be shown to fail
against the old code before it counts (`CLAUDE.md`).
