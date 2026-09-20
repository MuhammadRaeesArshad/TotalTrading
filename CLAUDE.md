# TotalTrading

Locally-run forex system. Scans majors and minors for a defined setup, backtests it
over years of history, and has a local model write up what it found. Everything runs
on one Windows machine — prices, credentials and the model. The UI is called **Meridian**.

Read this file before doing anything. It is the contract between sessions.

## Start here

Every session, in this order:

1. **This file** — the rules and the layout. They are not suggestions.
2. **`docs/STATE.md`** — what is built, what is not, what decisions are open.
3. **`docs/specs/`** — only the one for the feature you are touching.

Then, before you claim anything works:

```bash
bash scripts/verify.sh          # every test in the repo, ~2 min
```

The rules below are not only prose. `scripts/checks/rules.sh` — the first thing
`verify.sh` runs — fails the build if one is broken, so a rule that gets
forgotten is caught in the same minute rather than three days later. Adding a
rule means adding its check where a check is possible.

Bringing the stack up, and the local quirks that will otherwise waste an hour
(native Rust does not run on this machine; the MT5 connector is not in Docker),
are in `docs/STATE.md`.

**Update `docs/STATE.md` when you finish a piece of work** — what changed, what
it opened up, what is still undecided. That file is the next session's memory,
and stale is worse than empty.

## Rules

Load-bearing. Breaking one causes a class of bug, not a single bug.

1. **One detection implementation.** Detection lives in `engine-core` (Rust) and nowhere
   else. Live scanning and backtesting call the same `Detector`, so a rule can never mean
   two different things. Never port detection to another language "temporarily".
2. **`mt5-connector` is the only broker-aware service.** Only it imports `MetaTrader5`.
   Swapping brokers means rewriting that one service against the same HTTP contract.
3. **The gateway is the only Mongo writer.** Compute services return results and publish
   to Redis; the gateway persists them. Document shapes are defined once, in the
   gateway's schemas. A second writer means a second definition of the same document.
4. **No lookahead, ever.** Detectors read through `BarCtx`, which cannot reach a future
   bar. Any live-scanning path is bound by the same restriction. Do not add a method to
   `BarCtx` that exposes the full series.
5. **Costs are pessimistic by default.** Spread, slippage and commission apply on every
   fill; ambiguous bars resolve against the strategy (`IntrabarPolicy::Pessimistic`).
   Exits are checked from the entry bar itself — skipping it once turned a stopped-out
   trade into a winner, and a test now pins that. A result that improves because a
   cost was removed is not a result.
6. **Detection changes are versioned.** Changing a detector's rules bumps its version,
   and stored backtests record the version that produced them. Results across versions
   are not comparable and must not be charted together.
7. **The LLM never detects.** It receives already-computed structured signals and writes
   prose. It never decides what a setup is, and never sees raw bars.
8. **No live order execution until demo parity is proven.** Execution stays off until
   live and backtest results have been cross-checked on a demo account.
9. **AI is an add-on, never a dependency.** Scanning and backtesting must work with
   `ai-analysis` and Ollama switched off entirely. Nothing in the critical path may call
   it, wait on it, or fail because it is absent — the engine has no `AI_ANALYSIS_URL` and
   must not gain one. Commentary is something you attach to a finished result, never a
   step in producing one. Probes of it catch and report unreachable; they never throw.

## Language policy

Each language earns its place once. If a task could go in two of these, it goes in the
one listed higher.

- **Rust** — anything touching a bar, a price, a fill, or money. Detection, simulation,
  metrics, the bar cache, history import.
- **TypeScript** — everything web-facing and orchestration: REST API, auth, persistence,
  WebSocket relay, the UI, the AI service.
- **Python** — only where a vendor library forces it. Today that is exactly one thing:
  the `MetaTrader5` package, which drives a running terminal over IPC and ships no Linux
  wheel. Do not add a second Python service without a forcing reason.

## Parallelism

Speed comes from rayon inside the engine process, not from splitting services. The engine
already runs `par_iter` across (symbol, timeframe) tasks and saturates every core it is
given. Adding services on one machine does not add cores — it adds serialization, network
hops and contention for the same threads.

Services are split for **isolation and swappability**, never for throughput. If a backtest
is slow, the levers are the engine's CPU limit in compose, running it natively instead of
in Docker, and the algorithm — in that order.

## Services

| Service | Language | Runs | Owns | Port |
|---|---|---|---|---|
| `services/engine` | Rust | Docker or native | Detection, backtest, live scan, bar cache. Publishes to Redis. | 8004 |
| `services/api-gateway` | NestJS | Docker | Auth, REST, sole Mongo writer, Redis→WS relay. The only thing the browser talks to. | 4000 |
| `services/ai-analysis` | NestJS | Docker | Ollama client. Structured data in, prose out. Stateless. | 8003 |
| `services/mt5-connector` | Python | **Native Windows** | MetaTrader 5 bridge. The only broker-aware service. Stateless. | 8001 |
| `apps/web` | React + Vite | — | Meridian | 8080 / 5173 |
| RedisStack | — | Docker | TimeSeries, JSON, pub/sub | 6379 |
| MongoDB | — | Docker | Persistent history | 27017 |

Mongo collections, all written by the gateway: `users`, `mt5_accounts`, `instruments`,
`strategy_configs`, `zones_history`, `signals_log`, `backtests`, `trades_journal`,
`ai_analysis`, `system_logs`.

## Layout

```
apps/web/                     React + Vite + TS — Meridian
packages/contracts/           shared TS types across every TS consumer
services/engine/              Rust workspace
services/api-gateway/         NestJS
services/ai-analysis/         NestJS
services/mt5-connector/       Python + FastAPI
infra/{docker,k8s}/
docs/specs/                   one design doc per feature, dated YYYY-MM-DD-<topic>.md
docs/adr/                     architecture decisions
```

**Each of those has its own `CLAUDE.md`** holding its folder layout and the
conventions of its language. They load when you work in that directory, so a
session touching the UI never carries the Rust layout and vice versa — which is
the point: this file stays short enough to be read every time, and detail grows
where it belongs instead of here.

| Working on | Read |
|---|---|
| detection, simulation, the bar cache | `services/engine/CLAUDE.md` |
| REST, auth, persistence | `services/api-gateway/CLAUDE.md` |
| commentary from the local model | `services/ai-analysis/CLAUDE.md` |
| the broker bridge | `services/mt5-connector/CLAUDE.md` |
| Meridian | `apps/web/CLAUDE.md` |

### `packages/contracts` — planned, not yet created

```
src/
  index.ts
  generated/                  ts-rs output from Rust structs. Never hand-edit.
  api/                        gateway REST shapes
```

**This package does not exist yet.** Until it does, each TS service declares its own
shapes — `api-gateway/src/backtest/backtest.client.ts` and `apps/web/src/lib/types.ts`
already duplicate engine types, which is the drift it is meant to stop. Creating it needs
npm workspaces at the root, which in turn means every service Dockerfile has to copy the
root manifests instead of its own `package.json`. Do not import from it until it is real.
See `docs/specs/2026-09-19-architecture-rules-design.md`.

### Where a new file goes

- **A detection rule, an indicator, a simulation change** → `engine-core`. Strategy-specific
  code goes in `strategies/`; anything reusable goes in `structure.rs` or `rolling.rs`.
- **An HTTP route on the engine** → `engine-service`, never `engine-core`.
- **A shape crossing a service boundary** → `packages/contracts`. Generated from the Rust
  struct where the engine produces it. Never redeclare it locally.
- **Anything a browser calls** → `api-gateway`. The browser never calls another service.
- **A new page** → `pages/`, composing a feature. The logic goes in `features/`.
- **A new env var** → `config/configuration.ts`, plus compose and the k8s ConfigMap.

Match the surrounding file's style over any rule here. A file past ~400 lines is usually
doing two jobs.

## Conventions

**Tests.** Non-trivial logic leaves one runnable check behind — the smallest thing that
fails if the logic breaks. Money paths, detection and parsers get real tests with named
fixtures. Trivial one-liners get none. A regression test must be shown to fail against
the old code before it counts.


**Rules.** A rule a grep can decide gets a case in `scripts/checks/rules.sh`,
proven to fail when the rule is broken. The rest — no lookahead, pessimistic
costs, versioned detection — are pinned by the Rust tests instead.

**Commits.** Conventional prefixes (`feat:`, `fix:`, `refactor:`, `docs:`). Say why in the
body when the diff does not make it obvious.

## Decisions you make, and decisions you bring to me

**Decide yourself, then say what you chose in one line:**
file placement inside the layout above; naming; internal structure and refactors within one
service; test cases and fixtures; parameter defaults, as long as they are named in config
and stated; a dependency already in the lockfile.

**Stop and ask:**
anything that changes what a detection rule means, or the meaning of its parameters; a new
service, a new language, or a new top-level dependency; a Mongo schema change; anything
that changes what a stored backtest means or makes old ones incomparable; turning on order
execution, under any circumstances.

**Never assume a strategy.** If detection rules are not written down in `docs/specs/` or
given in the conversation, stop and ask. No placeholder rules — a guessed rule propagates
into live scanning and gets traded.

Current strategies, all implemented: `smc_ob` (single timeframe, pipeline test,
`2026-09-19-smc-order-blocks-design.md`), `smc_mtf` (the user's own multi-timeframe
strategy, `2026-09-20-smc-mtf-design.md`) and `trend_engulf` (ported from the user's
`finance-trader-backend`, `2026-09-20-trend-engulfing-design.md`).

**A port is still a strategy.** Rules taken from working code elsewhere get the same
treatment as rules given in conversation: written into a spec first, with every place the
port deviates from the original stated and why. Code beats its own docstring when the two
disagree, and the disagreement gets flagged rather than silently resolved.

**Strategies own their settings.** A `DetectorFactory` declares its description, the
timeframes it needs and a schema for its parameters; `GET /detectors` serves them and the
form builds itself. Metrics stay common to every strategy — that is what makes them
comparable — while settings and the per-trade `detail` are strategy-specific. Settings are
frozen onto each run, and unknown keys are refused rather than ignored.

## Skills

Create one in `.claude/skills/` when a workflow is repeated across sessions and its steps
are easy to get wrong — importing history for a pair set, running a backtest and
summarising it, cutting a release. One skill per workflow, named after the task. A skill
that is just a shell command does not need to exist.
