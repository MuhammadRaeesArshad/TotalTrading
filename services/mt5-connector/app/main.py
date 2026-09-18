"""mt5-connector — the only service that knows MetaTrader exists.

Runs natively on Windows alongside a logged-in MT5 terminal. Everything
upstream talks to it over plain HTTP, so replacing MetaTrader with another
broker means rewriting this service alone (project spec §4).
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .models import (
    AccountInfo, Candle, CandlesRangeRequest, CandlesRequest, Credentials,
    Health, SymbolInfo, SymbolsRequest,
)
from .mt5_gateway import Mt5Error, build_gateway

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("mt5-connector")

VERSION = "0.1.0"

app = FastAPI(
    title="mt5-connector",
    version=VERSION,
    description="Wraps the MetaTrader 5 terminal. Nothing else imports MetaTrader5.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.getenv("CORS_ORIGINS", "http://localhost:4000").split(",")
        if o.strip()
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

gateway = build_gateway()


@app.get("/health", response_model=Health)
def health() -> Health:
    available = gateway.terminal_available()
    return Health(
        status="ok" if (available or gateway.mode == "mock") else "degraded",
        mode=gateway.mode,
        terminal_available=available,
        version=VERSION,
        detail=(
            "Serving synthetic candles. Install MetaTrader5 on Windows for real prices."
            if gateway.mode == "mock"
            else None
        ),
    )


@app.post("/account", response_model=AccountInfo)
def account(creds: Credentials) -> AccountInfo:
    try:
        return gateway.account_info(creds)
    except Mt5Error as exc:
        # 400, not 500: these are all things the user can fix.
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/symbols", response_model=list[SymbolInfo])
def symbols(req: SymbolsRequest) -> list[SymbolInfo]:
    try:
        return gateway.symbols(req, req.group)
    except Mt5Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/candles", response_model=list[Candle])
def candles(req: CandlesRequest) -> list[Candle]:
    try:
        return gateway.candles(req, req.symbol, req.timeframe, req.count)
    except Mt5Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/candles/range", response_model=list[Candle])
def candles_range(req: CandlesRangeRequest) -> list[Candle]:
    """Candles between two instants, for backfilling the bar cache.

    An empty list is a valid answer — weekends and holidays have no bars — so
    the importer treats it as "nothing here, move on" rather than a failure.
    """
    if req.from_ts >= req.to_ts:
        raise HTTPException(
            status_code=400, detail="`from_ts` must come before `to_ts`."
        )
    try:
        return gateway.candles_range(
            req, req.symbol, req.timeframe, req.from_ts, req.to_ts, req.limit
        )
    except Mt5Error as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# --- Not built yet ---------------------------------------------------------
# /stream   publishes new-bar events to Redis pub/sub    (build order step 2)
# /positions, /history  reconcile open trades and MT5 deal history
# /orders   execution. Stays unimplemented until backtest and live results
#           have been cross-checked on a demo account (spec §6.4).
