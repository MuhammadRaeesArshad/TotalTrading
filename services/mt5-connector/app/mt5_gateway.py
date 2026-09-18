"""Everything that touches the MetaTrader5 package lives here.

Two implementations behind one interface:

  LiveGateway  wraps the real terminal. Windows only — the MetaTrader5 package
               drives a running MT5 install over IPC and has no Linux build.
  MockGateway  generates plausible candles and a fake balance, so the rest of
               the stack (gateway, frontend, k8s) can be developed and demoed
               on Linux or in CI without a terminal.

`build_gateway()` picks one at import time. Mock mode is loud about itself —
it shows up in /health and in the UI — so nobody mistakes synthetic candles
for broker data.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import random
import threading
from datetime import datetime, timedelta, timezone

from .models import AccountInfo, Candle, Credentials, SymbolInfo

log = logging.getLogger(__name__)

TIMEFRAME_MINUTES = {
    "M1": 1, "M5": 5, "M15": 15, "M30": 30,
    "H1": 60, "H4": 240, "D1": 1440, "W1": 10080, "MN1": 43200,
}


class Mt5Error(RuntimeError):
    """A failure the user can act on — bad credentials, unknown symbol, no terminal."""


class BaseGateway:
    mode: str = "unknown"

    def terminal_available(self) -> bool:
        raise NotImplementedError

    def account_info(self, creds: Credentials) -> AccountInfo:
        raise NotImplementedError

    def symbols(self, creds: Credentials, group: str | None) -> list[SymbolInfo]:
        raise NotImplementedError

    def candles(
        self, creds: Credentials, symbol: str, timeframe: str, count: int
    ) -> list[Candle]:
        raise NotImplementedError


class LiveGateway(BaseGateway):
    mode = "live"

    def __init__(self) -> None:
        import MetaTrader5 as mt5  # noqa: N813  (upstream's own capitalisation)

        self._mt5 = mt5
        # The MetaTrader5 package is not thread-safe and FastAPI runs sync
        # handlers in a threadpool, so every call is serialised through this.
        self._lock = threading.Lock()
        self._session: tuple[str, str] | None = None

        self._timeframes = {
            "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5,
            "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30,
            "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
            "D1": mt5.TIMEFRAME_D1, "W1": mt5.TIMEFRAME_W1,
            "MN1": mt5.TIMEFRAME_MN1,
        }

    def terminal_available(self) -> bool:
        with self._lock:
            if not self._mt5.initialize():
                return False
            return self._mt5.terminal_info() is not None

    def _ensure_login(self, creds: Credentials) -> None:
        """Re-logs in only when the requested account differs from the current one.

        MT5 holds one session per terminal, so switching accounts mid-scan is a
        real cost. The gateway is expected to be pinned to one account at a time.
        """
        key = (creds.login, creds.server)
        if self._session == key:
            return

        terminal_path = os.getenv("MT5_TERMINAL_PATH")
        init_kwargs = {"path": terminal_path} if terminal_path else {}

        if not self._mt5.initialize(**init_kwargs):
            code, msg = self._mt5.last_error()
            raise Mt5Error(
                f"Could not reach the MetaTrader 5 terminal ({code}: {msg}). "
                "Make sure it is installed, running, and logged in at least once."
            )

        ok = self._mt5.login(
            login=int(creds.login), password=creds.password, server=creds.server
        )
        if not ok:
            code, msg = self._mt5.last_error()
            raise Mt5Error(
                f"MT5 rejected login {creds.login} on {creds.server} ({code}: {msg})."
            )

        self._session = key
        log.info("Logged in to %s on %s", creds.login, creds.server)

    def account_info(self, creds: Credentials) -> AccountInfo:
        with self._lock:
            self._ensure_login(creds)
            info = self._mt5.account_info()
            if info is None:
                raise Mt5Error("MT5 returned no account info after a successful login.")

            return AccountInfo(
                login=str(info.login),
                server=info.server,
                name=info.name,
                company=info.company,
                currency=info.currency,
                balance=info.balance,
                equity=info.equity,
                margin=info.margin,
                margin_free=info.margin_free,
                margin_level=info.margin_level,
                profit=info.profit,
                leverage=info.leverage,
                trade_allowed=bool(info.trade_allowed),
            )

    def symbols(self, creds: Credentials, group: str | None) -> list[SymbolInfo]:
        with self._lock:
            self._ensure_login(creds)
            raw = self._mt5.symbols_get(group) if group else self._mt5.symbols_get()
            if raw is None:
                raise Mt5Error("MT5 returned no symbols. Check Market Watch is populated.")

            return [
                SymbolInfo(
                    name=s.name,
                    description=s.description or "",
                    base_currency=s.currency_base or None,
                    profit_currency=s.currency_profit or None,
                    digits=s.digits,
                    point=s.point,
                    trade_contract_size=s.trade_contract_size,
                    volume_min=s.volume_min,
                    volume_max=s.volume_max,
                    volume_step=s.volume_step,
                    selected=bool(s.select),
                    trade_allowed=s.trade_mode != self._mt5.SYMBOL_TRADE_MODE_DISABLED,
                )
                for s in raw
            ]

    def candles(
        self, creds: Credentials, symbol: str, timeframe: str, count: int
    ) -> list[Candle]:
        with self._lock:
            self._ensure_login(creds)

            # A symbol that isn't in Market Watch returns no rates, even though
            # symbols_get() lists it. Select it first.
            if not self._mt5.symbol_select(symbol, True):
                raise Mt5Error(f"{symbol} could not be added to Market Watch.")

            rates = self._mt5.copy_rates_from_pos(
                symbol, self._timeframes[timeframe], 0, count
            )
            if rates is None or len(rates) == 0:
                code, msg = self._mt5.last_error()
                raise Mt5Error(
                    f"No {timeframe} history for {symbol} ({code}: {msg}). "
                    "Lower timeframes are often capped by the broker."
                )

            return [
                Candle(
                    time=datetime.fromtimestamp(int(r["time"]), tz=timezone.utc),
                    open=float(r["open"]),
                    high=float(r["high"]),
                    low=float(r["low"]),
                    close=float(r["close"]),
                    tick_volume=int(r["tick_volume"]),
                    spread=int(r["spread"]),
                )
                for r in rates
            ]


MOCK_PAIRS = [
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
    "EURGBP", "EURJPY", "EURCHF", "EURAUD", "EURCAD", "EURNZD",
    "GBPJPY", "GBPCHF", "GBPAUD", "GBPCAD", "GBPNZD",
    "AUDJPY", "AUDCHF", "AUDCAD", "AUDNZD",
    "NZDJPY", "NZDCHF", "NZDCAD",
    "CADJPY", "CADCHF", "CHFJPY",
]

MOCK_BASE_PRICE = {
    "EURUSD": 1.0850, "GBPUSD": 1.2700, "USDJPY": 149.50, "USDCHF": 0.8800,
    "USDCAD": 1.3600, "AUDUSD": 0.6600, "NZDUSD": 0.6100, "EURGBP": 0.8540,
    "EURJPY": 162.20, "GBPJPY": 189.90, "CHFJPY": 169.80,
}


class MockGateway(BaseGateway):
    """Deterministic synthetic data. Same symbol always produces the same series,
    so a UI bug looks like a UI bug rather than fresh random noise."""

    mode = "mock"

    def terminal_available(self) -> bool:
        return False

    def account_info(self, creds: Credentials) -> AccountInfo:
        if not creds.password:
            raise Mt5Error("A password is required, even in mock mode.")

        seed = int(hashlib.sha256(creds.login.encode()).hexdigest()[:8], 16)
        rng = random.Random(seed)
        balance = round(10_000 + rng.random() * 40_000, 2)
        profit = round((rng.random() - 0.45) * balance * 0.08, 2)

        return AccountInfo(
            login=creds.login,
            server=creds.server,
            name="Mock Account",
            company="TotalTrading Mock Broker",
            currency="USD",
            balance=balance,
            equity=round(balance + profit, 2),
            margin=round(balance * 0.08, 2),
            margin_free=round(balance * 0.92 + profit, 2),
            margin_level=round(1100 + rng.random() * 400, 2),
            profit=profit,
            leverage=500,
            trade_allowed=False,
        )

    def symbols(self, creds: Credentials, group: str | None) -> list[SymbolInfo]:
        names = MOCK_PAIRS
        if group:
            needle = group.strip("*").upper()
            names = [n for n in names if needle in n]

        return [
            SymbolInfo(
                name=name,
                description=f"{name[:3]} vs {name[3:]}",
                base_currency=name[:3],
                profit_currency=name[3:],
                digits=3 if name.endswith("JPY") else 5,
                point=0.001 if name.endswith("JPY") else 0.00001,
                selected=name in MOCK_BASE_PRICE,
            )
            for name in names
        ]

    def candles(
        self, creds: Credentials, symbol: str, timeframe: str, count: int
    ) -> list[Candle]:
        if timeframe not in TIMEFRAME_MINUTES:
            raise Mt5Error(f"{timeframe} is not a timeframe this connector knows.")

        base = MOCK_BASE_PRICE.get(symbol)
        if base is None:
            # Unknown-but-plausible pair: derive a stable price from the name.
            digest = int(hashlib.sha256(symbol.encode()).hexdigest()[:6], 16)
            base = 0.6 + (digest % 1000) / 1000.0

        jpy = symbol.endswith("JPY")
        vol = base * (0.0006 if not jpy else 0.0009)
        step = timedelta(minutes=TIMEFRAME_MINUTES[timeframe])
        rng = random.Random(f"{symbol}:{timeframe}")

        start = datetime.now(timezone.utc).replace(second=0, microsecond=0) - step * count
        price = base
        out: list[Candle] = []

        for i in range(count):
            # A slow sine plus noise — enough shape to render a chart against,
            # not pretending to be a market.
            drift = math.sin(i / 42.0) * vol * 1.6
            price = price + drift + rng.gauss(0, vol)
            o = price
            c = price + rng.gauss(0, vol)
            h = max(o, c) + abs(rng.gauss(0, vol * 0.6))
            l = min(o, c) - abs(rng.gauss(0, vol * 0.6))
            digits = 3 if jpy else 5
            out.append(
                Candle(
                    time=start + step * i,
                    open=round(o, digits),
                    high=round(h, digits),
                    low=round(l, digits),
                    close=round(c, digits),
                    tick_volume=rng.randint(180, 2400),
                    spread=rng.randint(1, 14),
                )
            )
            price = c

        return out


def build_gateway() -> BaseGateway:
    """Live if the package imports and mock mode isn't forced, otherwise mock."""
    if os.getenv("MT5_FORCE_MOCK", "").lower() in {"1", "true", "yes"}:
        log.warning("MT5_FORCE_MOCK is set — serving synthetic data.")
        return MockGateway()

    try:
        return LiveGateway()
    except ImportError:
        log.warning(
            "The MetaTrader5 package is not installed (it is Windows-only). "
            "Serving synthetic data so the rest of the stack can run. "
            "Install it on the Windows box for real prices."
        )
        return MockGateway()
