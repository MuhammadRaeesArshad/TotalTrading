"""ai-analysis — local model commentary on already-computed results.

Health endpoint only, for now. Build order step 8.

Two rules this service exists to enforce:

  1. The model summarises, it does not detect. It is handed structured signal
     and backtest documents and asked to write them up in plain language. It is
     never shown raw OHLC arrays and never asked to find a pattern (spec §5).
  2. Everything stays on the machine. Ollama runs locally against the RX 9060
     XT — via ROCm v7/HIP7, or Vulkan if ROCm doesn't pick the card up.

A 7–14B instruct model is plenty for summarising JSON.
"""

from __future__ import annotations

import os

from fastapi import FastAPI

VERSION = "0.1.0"

app = FastAPI(title="ai-analysis", version=VERSION)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "ai-analysis",
        "version": VERSION,
        "ollama_url": os.getenv("OLLAMA_URL", "http://localhost:11434"),
        "model": os.getenv("OLLAMA_MODEL", "not configured"),
        "implemented": False,
        "detail": "Ollama integration lands in build order step 8.",
    }


@app.get("/ready")
def ready() -> dict:
    return {"status": "ok"}
