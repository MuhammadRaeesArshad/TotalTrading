# mt5-connector

Wraps the MetaTrader 5 terminal behind an HTTP API. **This is the only service
that imports the `MetaTrader5` package** — swapping brokers later means
rewriting this service and nothing else.

## Running it for real (Windows)

The `MetaTrader5` Python package drives a running MT5 install over IPC. It is
Windows-only and needs the terminal on the same machine, so this service runs
natively rather than in Docker.

```powershell
cd services\mt5-connector
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001
```

Before the first run: open MT5, log into the account, and tick
**Tools → Options → Expert Advisors → Allow algorithmic trading**. The terminal
must have logged in at least once by hand — the API cannot do the initial
handshake on its own.

If MT5 is installed somewhere non-standard, point at it:

```powershell
$env:MT5_TERMINAL_PATH = "C:\Program Files\MetaTrader 5\terminal64.exe"
```

## Mock mode

Without the `MetaTrader5` package — on Linux, in Docker, in CI — the service
serves deterministic synthetic candles instead of failing. That keeps the
gateway, frontend and k8s manifests developable anywhere.

Mock mode announces itself in `GET /health` (`"mode": "mock"`) and the frontend
shows a banner for it. Force it on a Windows box with `MT5_FORCE_MOCK=true`.

**Synthetic candles are not market data.** Never judge a strategy on them.

## Endpoints

| Method | Path       | Does                                             |
|--------|------------|--------------------------------------------------|
| GET    | `/health`  | Liveness, plus whether a real terminal is present |
| POST   | `/account` | Log in, return balance/equity/margin              |
| POST   | `/symbols` | Every symbol the broker offers                    |
| POST   | `/candles` | OHLC history for one symbol and timeframe         |

Credentials are passed per request rather than held in a session, so the
connector stays stateless and the gateway remains the only thing storing them.

## Not built yet

- Redis pub/sub on new bar (build order step 2)
- `/positions` and `/history` reconciliation
- `/orders` — execution stays unimplemented until backtest and live results
  have been cross-checked on a demo account (spec §6.4)
