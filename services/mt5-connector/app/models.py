"""Request and response shapes for the connector's HTTP contract.

These mirror services/api-gateway/src/mt5/mt5.types.ts. If you change one,
change the other — that pairing is the whole interface between the two
services, and nothing else in the system knows MetaTrader exists.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class Credentials(BaseModel):
    login: str = Field(..., description="MT5 login number, as a string")
    password: str
    server: str = Field(..., description="Server name exactly as the terminal spells it")


class SymbolsRequest(Credentials):
    group: str | None = Field(
        None,
        description="MT5 group filter, e.g. '*USD*'. Omit to return everything.",
    )


Tf = Literal["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"]


class CandlesRequest(Credentials):
    symbol: str
    timeframe: Tf
    count: int = Field(500, ge=1, le=5000)


class CandlesRangeRequest(Credentials):
    """Candles between two instants, for backfilling the bar cache.

    `/candles` reads backwards from the present, which is right for a live
    scanner and useless for an import: there is no way to ask it for 2019. This
    maps onto MT5's `copy_rates_range`, so the importer can page through years
    by walking the window forward.
    """

    symbol: str
    timeframe: Tf
    from_ts: int = Field(..., description="Unix seconds, inclusive")
    to_ts: int = Field(..., description="Unix seconds, inclusive")
    limit: int = Field(
        200_000,
        ge=1,
        le=500_000,
        description=(
            "Safety cap on one response. MT5 itself caps history by the "
            "terminal's Max bars in chart setting, which is usually the "
            "binding limit long before this is."
        ),
    )


class AccountInfo(BaseModel):
    login: str
    server: str
    name: str
    company: str
    currency: str
    balance: float
    equity: float
    margin: float
    margin_free: float
    margin_level: float
    profit: float
    leverage: int
    trade_allowed: bool


class SymbolInfo(BaseModel):
    name: str
    description: str = ""
    base_currency: str | None = None
    profit_currency: str | None = None
    digits: int = 5
    point: float = 0.00001
    trade_contract_size: float = 100_000.0
    volume_min: float = 0.01
    volume_max: float = 100.0
    volume_step: float = 0.01
    selected: bool = False
    trade_allowed: bool = True
    # Overnight financing, in points per lot per night, as the terminal states
    # it. Negative is a charge. Positive on one side of a carry pair, which is
    # why the backtester cannot guess these and has to be told.
    swap_long: float = 0.0
    swap_short: float = 0.0
    # Weekday charged triple, 0 = Sunday. Brokers vary; MT5 reports its own.
    swap_triple_weekday: int = 3


class Candle(BaseModel):
    time: datetime
    open: float
    high: float
    low: float
    close: float
    tick_volume: int
    spread: int = 0


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    mode: Literal["live", "mock"]
    terminal_available: bool
    version: str
    detail: str | None = None
