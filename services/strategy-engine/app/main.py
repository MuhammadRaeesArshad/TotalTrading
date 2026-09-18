"""strategy-engine — scans every pair and timeframe for the strategy's setups.

Health endpoint only, for now.

The detection logic is deliberately not written yet. The strategy definition is
still being redefined (project spec §3), and a placeholder here would end up
copied into backtest-engine, giving two implementations of rules nobody has
agreed on. Build order step 3 starts when the rules land.

When they do:
  app/detection.py   pure functions over a pandas DataFrame of OHLC. No I/O,
                     no Mongo, no Redis — just candles in, signals out, so the
                     backtester can import the same functions unchanged (§6.3).
  app/scanner.py     subscribes to new-bar events, calls detection, writes
                     signal state to Redis and Mongo.
"""

from __future__ import annotations

import os

from fastapi import FastAPI

VERSION = "0.1.0"

app = FastAPI(title="strategy-engine", version=VERSION)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "strategy-engine",
        "version": VERSION,
        "detection_implemented": False,
        "detail": "Waiting on the finalized strategy definition before detection is written.",
    }


@app.get("/ready")
def ready() -> dict:
    # Nothing to be ready for yet — it reports up so k8s doesn't flap the pod.
    return {"status": "ok", "mongo": os.getenv("MONGO_URI") is not None}
