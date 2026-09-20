# MT5 connector — Python

The MetaTrader 5 bridge, and the only broker-aware service. Runs natively on
Windows with the terminal open; it is not in Docker and cannot be.

The rules, the service table and where a new file goes are in the root
`CLAUDE.md`. Read that first; this file is only what is specific to here.

## Layout

```
app/
  main.py                     FastAPI routes only
  mt5_gateway.py              every MetaTrader5 call. Nothing else imports the package.
  models.py                   Pydantic request/response models
```

## Conventions

**Python.** Type hints on every signature. Pydantic models for request and response.
`mt5-connector` keeps all `MetaTrader5` calls behind `mt5_gateway.py` so the rest of the
service is testable without a terminal.

Python is here under protest: the `MetaTrader5` package drives a running
terminal over IPC and ships no Linux wheel. That is the forcing reason, and the
only one. The venv is 3.12 — the pinned deps have no wheels for 3.13+.

Execution stays off (rule 8). `order_send` appearing anywhere fails
`scripts/checks/rules.sh`.
