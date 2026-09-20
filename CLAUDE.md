# TotalTrading

Locally-run forex system. Scans majors and minors for a defined setup, backtests it
over years of history, and has a local model write up what it found. Everything runs
on one Windows machine — prices, credentials and the model. The UI is called **Meridian**.

Read this file before doing anything. It is the contract between sessions.

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

### Rust — `services/engine`

```
crates/
  engine-core/                no async, no HTTP, no Mongo, no Redis. mmap is the only I/O.
    src/
      lib.rs                  re-exports; the crate's public surface
      error.rs                every error type, one enum
      timeframe.rs
      store/                  the bar cache
        bars.rs               columnar mmap reader
        format.rs             the on-disk .ttb layout
        writer.rs
      engine/
        rolling.rs            reusable primitives — no strategy knowledge
        window.rs             BarCtx, the no-lookahead gate
        align.rs              multi-timeframe mapping
        detector.rs           Detector + DetectorFactory + registry
        strategies/           one module per strategy, e.g. smc.rs
        structure.rs          shared structure primitives (swings, zones)
        sim.rs                fills, exits, costs
        metrics.rs
        runner.rs             orchestration + rayon
    tests/                    one file per invariant, named after what it protects
    examples/                 throughput.rs and friends
  engine-service/             axum only. No strategy logic, ever.
    src/
      main.rs                 routes + AppState
      jobs.rs                 job queue, progress, cancellation
      importer.rs             pulls history from mt5-connector
      instruments.rs
```

A strategy is a module in `engine/strategies/` implementing `Detector`, registered in the
registry. Anything reusable it needs that is not strategy-specific goes in `structure.rs`
or `rolling.rs` so the next strategy gets it free.

### NestJS — `services/api-gateway`, `services/ai-analysis`

Feature-module layout. One folder per domain area, flat, no nesting by layer.

```
src/
  main.ts                     bootstrap only
  app.module.ts               wires feature modules together
  config/configuration.ts     every env var read here, nowhere else
  common/                     guards, interceptors, pipes, crypto. No domain logic.
  schemas/                    Mongoose models — the single definition of each document
  <feature>/                  auth/ accounts/ backtest/ mt5/ users/
    <feature>.module.ts
    <feature>.controller.ts   validates and delegates. No logic.
    <feature>.service.ts      the logic
    <feature>.client.ts       outbound HTTP to another service
    dto.ts                    request/response shapes for this feature
  health/
```

`schemas/` exists only in `api-gateway` — it is the only Mongo writer. `ai-analysis` has
no `schemas/` and no database connection.

### React — `apps/web`

```
src/
  main.tsx                    entry
  App.tsx                     router
  features/<feature>/         one folder per domain area
    components/               UI used only by this feature
    hooks/                    useBacktests.ts
    api.ts                    calls the gateway, typed from @totaltrading/contracts
    store.ts                  state local to this feature
  components/                 shared and dumb — no feature knowledge
    charts/                   EquityCurve, RMultipleHistogram, Sparkline, Heatmap
    ui/                       Button, Modal, PageHeader
  pages/                      route-level. Composes features, holds no logic and fetches nothing.
  lib/                        cross-cutting: api client, auth, ws, format
  stores/                     global state only — auth, connection status
  styles/
```

A component used by one feature lives in that feature; promote it to `components/` on its
second consumer, not in anticipation of one. Global state is React context in `stores/`;
there is no state library, and adding one is a decision to bring to me.

### Python — `services/mt5-connector`

```
app/
  main.py                     FastAPI routes only
  mt5_gateway.py              every MetaTrader5 call. Nothing else imports the package.
  models.py                   Pydantic request/response models
```

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

**Rust.** Small types with one job, composed by the caller — follow `rolling.rs`. Detectors
allocate nothing per bar and carry their own state. Public items get a doc comment saying
why, not what. Errors are typed in `error.rs`, never `unwrap()` outside tests. Integration
tests go in `crates/*/tests/`, named after what they protect.

**TypeScript.** Strict mode, no `any`. NestJS modules stay thin — a controller validates and
delegates, a service holds the logic. Shapes crossing a boundary come from
`packages/contracts`; never redeclare one locally. No default exports.

`api-gateway` predates this and still runs with `strictNullChecks: false` and
`noImplicitAny: false`. That is legacy, not the standard — tighten it when you are already
in the file, and do not copy its tsconfig into a new service. `ai-analysis` is the
reference.

**Python.** Type hints on every signature. Pydantic models for request and response.
`mt5-connector` keeps all `MetaTrader5` calls behind `mt5_gateway.py` so the rest of the
service is testable without a terminal.

**Tests.** Non-trivial logic leaves one runnable check behind — the smallest thing that
fails if the logic breaks. Money paths, detection and parsers get real tests with named
fixtures. Trivial one-liners get none. A regression test must be shown to fail against
the old code before it counts.

The web app has no test framework. Its pure logic (`features/*/stats.ts`) is written in
erasable TypeScript with no imports beyond types, and checked by `apps/web/checks/*.check.ts`
under plain `node` (22.6+ strips types). Keep it that way rather than adding a framework.

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

Current strategies, both implemented: `smc_ob` (single timeframe, pipeline test,
`2026-09-19-smc-order-blocks-design.md`) and `smc_mtf` (the user's own multi-timeframe
strategy, `2026-09-20-smc-mtf-design.md`).

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
