# Architecture rules rewrite

**Date:** 2026-09-19
**Status:** approved; migration done except the contracts package (step 4)

The six original rules were written before any code existed. Three of them turned out to
be unsatisfiable, contradicted by the wiring, or factually wrong about the runtime. This
replaces them and reshapes the services to match.

## What was wrong

**Rule 3 was unsatisfiable.** "Detection logic is shared between strategy-engine and
backtest-engine" — one is Python, the other Rust. Sharing meant either a port kept in sync
by discipline, which is exactly what the rule forbids, or an HTTP hop that reduces the
Python service to a proxy with no reason to exist.

**Rule 6 contradicted the wiring.** "One writer per Mongo collection — api-gateway
proxies, never writes directly." But `engine` has no `MONGO_URI` in compose, only
`BAR_CACHE_DIR`, `PORT`, `RUST_LOG` and `MT5_CONNECTOR_URL`. It cannot persist anything.
The gateway fetches results and writes them, so the gateway was writing another service's
collections — the thing the rule prohibits.

**The service table was wrong about the runtime.** It listed `ai-analysis` as native
because it "needs GPU". It does not. Ollama holds the GPU; `ai-analysis` makes HTTP calls
to port 11434, and compose already runs it in Docker via `host.docker.internal`.

## Decisions

### `strategy-engine` is deleted

Live scanning and backtesting are the same computation over different bar sources —
replay stored bars, or feed newly closed ones. The Rust service already owns the detector
registry, the bar cache, `BarCtx`, warmup handling, and a job system with progress and
cancellation. A Python scanner would reimplement all of it and reintroduce the rule 3
problem.

The service is 31 lines of `main.py` with a health endpoint. Nothing is lost.

*Alternative rejected:* keep it as a thin scheduler owning "when to scan" while Rust owns
"what is a signal". Rejected because `jobs.rs` already schedules, so the service would
duplicate the job system to save nothing.

### `ai-analysis` moves from Python to NestJS

Ollama is plain HTTP, so nothing forces Python. The service consumes the same signal and
backtest shapes the gateway and UI already use; in TypeScript those are shared through
`packages/contracts`, in Python they would be hand-copied and drift.

This also makes the language policy clean: Python exists only because the `MetaTrader5`
package forces it — one forced language, one reason.

### The gateway is the sole Mongo writer

The Mongoose schemas already live in the gateway. Giving Rust a Mongo connection means a
second definition of every document shape, in a second language — the same failure mode
rule 3 exists to prevent.

Compute services return results and publish to Redis. The gateway persists and serves.
The engine still owns the bar cache, which is its own private store, not Mongo.

### Services are not a parallelism lever

Recorded because it will otherwise be re-litigated. The engine runs `par_iter` across
(symbol, timeframe) tasks and saturates every core it is given. On one machine, more
services draw from the same thread pool while adding serialization and network hops.
Services exist for isolation and swappability.

The real levers, in order: the engine's `cpus` limit in compose (currently 4 of 12
available), running natively instead of through Docker's VM, then the algorithm.

## The rules

1. One detection implementation — `engine-core`, nowhere else.
2. `mt5-connector` is the only broker-aware service.
3. The gateway is the only Mongo writer.
4. No lookahead, ever.
5. Costs are pessimistic by default.
6. Detection changes are versioned; stored backtests record the version.
7. The LLM never detects.
8. No live order execution until demo parity is proven.

Full text in `CLAUDE.md`, which is the version sessions actually load.

## Migration

1. ~~Delete `services/strategy-engine`, its compose service and its k8s manifest.~~
2. ~~Rename `services/backtest-engine` → `services/engine`; crates `backtest-core` →
   `engine-core` and `backtest-service` → `engine-service`. Update `BACKTEST_ENGINE_URL`
   to `ENGINE_URL` in compose, k8s and the gateway.~~
3. ~~Rewrite `services/ai-analysis` as a NestJS service. Drop its `MONGO_URI`; it is
   stateless.~~
4. **Pending.** Add npm workspaces at the root and a `packages/contracts` package holding
   `Signal`, `Trade`, `Metrics` and the REST shapes. Generate the engine-produced types
   from the Rust structs with `ts-rs` so JSON and TypeScript cannot drift.

   Deferred because npm workspaces changes how every TS service builds: each Dockerfile
   currently does `COPY package.json ./` then `npm install`, which stops working once
   dependencies resolve through a root lockfile. Every Dockerfile has to copy the root
   manifests and build with `--workspace`. That is a build-system change and deserves its
   own pass rather than being tacked onto this one.
5. ~~Give the engine a `REDIS_URL` for publishing scan results.~~
6. ~~Delete `Signal::expires_after`.~~
7. ~~Update `README.md` and `infra/k8s` to match.~~

Step 2 was cosmetic and could have been skipped; it was done while the cost was low.

### Also changed, not originally listed

- `max_open_per_symbol` raised from 1 to 3 at the user's request. At the default 1% risk
  that is up to 3% of equity exposed per symbol.
- The engine's compose CPU limit raised from 4 to 10. The box has 12 logical cores; 10
  leaves two for the MT5 terminal and the gateway.
- `ai-analysis` gained a real `/analyze` endpoint and a `/health` that reports whether
  Ollama is reachable and the configured model is actually pulled, rather than a hardcoded
  `implemented: false`.
- The gateway gained `src/ai/ai.client.ts` so `status/services` reports `ai-analysis`
  honestly instead of `not_implemented`.

## Open, not decided here

**Limit fills.** `fill_entry` fills at the next bar's open at market. Real resting limit
orders would materially improve order-block entries, which want a fill at the zone edge
rather than one bar later. That is an engine change with its own spec, not a rule.

**Live scan scheduling.** How the engine learns a bar has closed — polling `mt5-connector`
or the connector pushing — is undecided. Needed before live scanning, not before the
migration.
