# HazeHub API — FastAPI on Cloud Run (or any Docker host).
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

# Cloud Run injects PORT (8080 by default); keep 8000 for local `docker run`.
ENV PORT=8000
EXPOSE 8000

# One worker on purpose: the in-memory read cache is authoritative and assumes
# a single writer (see app/cache.py). Deploy with --max-instances=1 and scale
# with concurrency, not processes.
CMD exec uvicorn app.main:app \
    --host 0.0.0.0 --port ${PORT} --workers 1 \
    --proxy-headers --forwarded-allow-ips "*" \
    --timeout-keep-alive 75
