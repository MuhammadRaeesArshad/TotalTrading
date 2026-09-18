# TotalTrading

A locally-run forex trading system. Scans majors and minors across timeframes
for a defined setup, backtests it over years of history, and has a local model
write up what it found. Everything runs on your own machine — prices,
credentials and the AI model all stay there.

The UI is called **Meridian**.

## What works today

- **Auth** — register, sign in, JWT access and refresh with rotation.
- **MT5 accounts** — add a login, connect, read balance and equity, pull the
  symbol list the broker actually offers, fetch candles.
- **Mongoose schemas** — users, MT5 accounts, instruments, strategies, signals,
  backtests, trades, AI reports, system logs.
- **The backtest engine** — Rust, measured at ~29M bars/sec on one core. Built
  and tested; it has no rules to run yet (see below).
- **History import** — pulls years of candles out of MetaTrader in overlapping
  chunks and writes them to a memory-mappable bar cache, and tells you how far
  back the terminal actually reaches.
- **Infra** — Docker Compose and Kubernetes manifests for the whole stack.

Every other page in the UI says what will land there and what it is waiting on.

## What is deliberately not built

**The strategy.** The rules are being redefined, so nothing in this repo
guesses at them. That is not laziness — `strategy-engine` and `backtest-engine`
are supposed to share *one* implementation of the rules, and a placeholder
written now would be copied into both before anyone agreed what it should say.
Detection sits behind a trait; the engine around it is finished.

**Order execution.** Switched off, and staying off until backtest and live
results have been cross-checked on a demo account.

## Services

| Service | Language | Runs where | Job |
|---|---|---|---|
| `apps/web` | React + Vite + TS | — | Meridian: auth, accounts, scanner, backtests, journal |
| `services/api-gateway` | NestJS | Docker or native | Auth, REST, the only thing the browser talks to |
| `services/mt5-connector` | Python + FastAPI | **Native on Windows** | Wraps MetaTrader 5. The only broker-aware service |
| `services/backtest-engine` | **Rust** | Docker or native | Replays history at speed |
| `services/strategy-engine` | Python | Docker or native | Live scanning. Health endpoint only |
| `services/ai-analysis` | Python | Native (needs GPU) | Local Ollama commentary. Health endpoint only |
| RedisStack | — | Docker | TimeSeries, JSON, pub/sub |
| MongoDB | — | Docker | Persistent history |

Three rules hold this shape together:

1. **Only `mt5-connector` imports `MetaTrader5`.** Swapping brokers means
   rewriting that one service against the same HTTP contract.
2. **Detection is shared, never duplicated.** One implementation, used by both
   the live scanner and the backtester.
3. **One writer per Mongo collection.** The gateway reads through; it does not
   write other services' collections.

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

Without it, the connector serves **synthetic candles** and says so — in
`/health`, and as a banner across the top of the app. Useful for building the
UI; never judge a strategy on them.

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

## Repository layout

```
apps/web/                  React frontend
services/
  api-gateway/             NestJS: auth, accounts, schemas
  mt5-connector/           FastAPI: the MetaTrader bridge
  backtest-engine/         Rust: the fast path
  strategy-engine/         Python: live scanning (stub)
  ai-analysis/             Python: local model (stub)
infra/
  docker/                  Compose stack
  k8s/                     Kustomize base and overlays
```

## Tests

```bash
cd services/api-gateway   && npm test    #  8 — credential encryption
cd services/backtest-engine && cargo test # 33 — storage, windows, lookahead, sim
```

## Build order

Each phase should run before the next starts.

1. ~~Infra — Compose, Kubernetes, health endpoints~~
2. ~~`mt5-connector` — connect, fetch candles~~ *(Redis new-bar events pending)*
3. `strategy-engine` — detection as pure, unit-tested functions **← blocked on the rules**
4. Scale to all pairs and timeframes; recompute D1/H4 on bar close only
5. ~~Gateway and dashboard skeleton~~ *(WebSocket relay pending)*
6. ~~`backtest-engine`~~ — engine and history import done; needs the rules and
   Mongo persistence
7. Backtest UI — equity curve, trade list, filters
8. `ai-analysis` — Ollama reading from Mongo
9. News ingestion, then confirm-before-send execution once parity is proven
