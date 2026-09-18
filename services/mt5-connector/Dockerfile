# Linux image for development and CI only — it can never reach a real terminal,
# so it always runs in mock mode. The Windows host runs this service natively:
#   python -m venv .venv && .venv\Scripts\activate
#   pip install -r requirements.txt
#   uvicorn app.main:app --port 8001
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 MT5_FORCE_MOCK=true

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd -m appuser
USER appuser

EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
