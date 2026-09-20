# TotalTrading

A locally-run forex trading system. Scans majors and minors across timeframes
for a defined setup, backtests it over years of history, and has a local model
write up what it found. Everything runs on your own machine — prices,
credentials and the AI model all stay there.

The UI is called **Meridian**.

Architecture rules and per-language conventions live in [CLAUDE.md](CLAUDE.md).
Read that before changing anything structural.

## What works today

- **Auth** — register, sign in, JWT access and refresh with rotation.
- **MT5 accounts** — add a login, connect, read balance and equity, pull the
  symbol list the broker actually offers, fetch candles.
- **Mongoose schemas** — users, MT5 accounts, instruments, strategies, signals,
  backtests, trades, AI reports, system logs.
- **The engine** — Rust, measured at ~29M bars/sec on one core. Every trade
  records why it was taken (the detector's `detail`), how far it went against
  and for you before exit (MAE/MFE in R), and exits are checked from the entry
  bar itself, so a stop hit in the first bar is not hidden.
- **`smc_ob`, the first detector** — trend by swing break of structure, order
  block at the last opposing candle, entry on first touch. A pipeline test,
  not a claimed edge. Spec: `docs/specs/2026-09-19-smc-order-blocks-design.md`.
- **History import** — pulls years of candles out of MetaTrader in overlapping
  chunks and writes them to a memory-mappable bar cache, and tells you how far
  back the terminal actually reaches.
- **Backtests in Meridian** — import history from your terminal, run a
  detector, and read the result: global stats, every trade with its chart and
  the detector's reasoning beside it, plus Verdict, Ledger, Replay and Anatomy
  views (Net R by pair, win rate by session, Net R by month). Runs are stored
  and survive restarts.
- **`ai-analysis`** — NestJS service wrapping a local Ollama. Takes computed
  figures and returns prose. Refuses anything that is not a flat scalar, so a
  price series cannot reach the model.
- **Infra** — Docker Compose and Kubernetes manifests for the whole stack.

Every other page in the UI says what will land there and what it is waiting on.

## What is deliberately not built

**Your own strategy.** The multi-timeframe version — 4H/1H trend, 30m/15m
break of structure, entry at the order block forming the next swing — is
captured as a draft with open questions in
`docs/specs/2026-09-19-smc-mtf-strategy-draft.md`. It is not built until those
are answered; a guessed rule would be traded.

**Order execution.** Switched off, and staying off until backtest and live
results have been cross-checked on a demo account.

## Services

| Service | Language | Runs where | Job |
|---|---|---|---|
| `apps/web` | React + Vite + TS | — | Meridian: auth, accounts, scanner, backtests, journal |
| `services/api-gateway` | NestJS | Docker or native | Auth, REST, sole Mongo writer, the only thing the browser talks to |
| `services/engine` | **Rust** | Docker or native | Detection, backtesting, live scanning, the bar cache |
| `services/ai-analysis` | NestJS | Docker | Local Ollama commentary. Stateless |
| `services/mt5-connector` | Python + FastAPI | **Native on Windows** | Wraps MetaTrader 5. The only broker-aware service |
| RedisStack | — | Docker | TimeSeries, JSON, pub/sub |
| MongoDB | — | Docker | Persistent history |

Four rules carry most of the shape. The full set is in [CLAUDE.md](CLAUDE.md).

1. **One detection implementation**, in `engine-core`. Live scanning and
   backtesting call the same `Detector`, so a rule cannot mean two things.
2. **Only `mt5-connector` imports `MetaTrader5`.** Swapping brokers means
   rewriting that one service against the same HTTP contract.
3. **The gateway is the only Mongo writer.** Compute services return results
   and publish to Redis; the gateway persists them.
4. **No lookahead, ever.** Detectors read through `BarCtx`, which cannot reach
   a future bar.

## Getting it running

```bash
cp infra/docker/.env.example infra/docker/.env
# Fill in three secrets:
openssl rand -hex 32   # JWT_ACCESS_SECRET
openssl rand -hex 32   # JWT_REFRESH_SECRET
openssl rand -hex 32   # MT5_CRED_KEY

docker compose -f infra/docker/docker-compose.yml up --build
```

Open http://localhost:8080 and create the first account — it becomes the owner.

`MT5_CRED_KEY` encrypts stored broker passwords (AES-256-GCM). Back it up
somewhere you can find again; losing it means re-entering every account.

### With a real MetaTrader terminal

`mt5-connector` runs natively on Windows, because the `MetaTrader5` package
drives a running terminal over IPC on the same machine:

```powershell
cd services\mt5-connector
python -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001
```

The pinned `MetaTrader5` and `pydantic` versions have no wheels for Python
3.13+. Build the venv on 3.12.

Without the connector, it serves **synthetic candles** and says so — in
`/health`, and as a banner across the top of the app. Useful for building the
UI; never judge a strategy on them.

### AI commentary

Ollama runs on the host, because it owns the GPU. `ai-analysis` reaches it over
HTTP and holds no GPU itself.

```powershell
ollama pull qwen2.5:14b
```

`GET /health` on port 8003 reports whether Ollama is reachable and whether the
configured model is actually pulled.

### Kubernetes

```bash
kubectl -n totaltrading create secret generic totaltrading-secrets \
  --from-literal=JWT_ACCESS_SECRET=$(openssl rand -hex 32) \
  --from-literal=JWT_REFRESH_SECRET=$(openssl rand -hex 32) \
  --from-literal=MT5_CRED_KEY=$(openssl rand -hex 32)

kubectl apply -k infra/k8s/overlays/local
```

`mt5-connector` is not in the cluster — it cannot be, since it needs a Windows
terminal. `infra/k8s/base/mt5-connector-endpoint.yaml` is a selector-less
Service pointing at a fixed IP, so `http://mt5-connector:8001` resolves inside
the cluster anyway. Set that IP per overlay.

## Engine routes

| Route | Does |
|---|---|
| `GET /detectors` | Registered detectors — `smc_ob` today |
| `POST /import` | Pulls history from `mt5-connector` into the bar cache |
| `GET /cache` | What is cached, per symbol and timeframe, with date ranges |
| `POST /runs` · `GET /runs/:id` | Start a backtest, read its result. `skipped` says why each signal that did not become a trade was dropped |
| `GET /bars/:symbol/:timeframe?from_ts&to_ts` | Bars for a trade's chart, capped at 5,000 |

Symbols are validated before they touch the file system — only letters,
digits and `. _ - #`. The engine port is published on the host, so this is not
an internal-only concern.

## Repository layout

```
apps/web/                  React frontend
services/
  api-gateway/             NestJS: auth, REST, the only Mongo writer
  engine/                  Rust: detection, backtesting, live scanning
  ai-analysis/             NestJS: local model commentary
  mt5-connector/           FastAPI: the MetaTrader bridge
infra/
  docker/                  Compose stack
  k8s/                     Kustomize base and overlays
docs/
  specs/                   one design doc per feature
  adr/                     architecture decisions
```

## Tests

```bash
cd services/api-gateway  && npm test     #  8 — credential encryption
cd services/ai-analysis  && npm test     # 13 — the narrate-only guard, model readiness
cd services/engine       && cargo test   # 65 — storage, lookahead, sim, sizing, skips, smc_ob
node apps/web/checks/stats.check.ts      # the results page's derived numbers
```

## Build order

Each phase should run before the next starts.

1. ~~Infra — Compose, Kubernetes, health endpoints~~
2. ~~`mt5-connector` — connect, fetch candles~~ *(Redis new-bar events pending)*
3. ~~**Detection**~~ — `smc_ob` in `engine-core`, unit-tested. Your own
   multi-timeframe strategy is drafted, waiting on answers.
4. Scale to all pairs and timeframes; recompute D1/H4 on bar close only
5. ~~Gateway and dashboard skeleton~~ *(WebSocket relay pending)*
6. ~~The engine~~ — engine, history import, per-trade detail and MAE/MFE,
   bars route for trade charts, runs persisted through the gateway
7. ~~Backtest results page~~ — trades with their charts, Verdict, Ledger,
   Replay, Anatomy
8. ~~`ai-analysis`~~ — Ollama wired; needs real results to describe
9. News ingestion, then confirm-before-send execution once parity is proven
