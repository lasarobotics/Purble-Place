# HazeHub — the whole app in one container.
#
# Stage 1 builds the Next.js static export; stage 2 runs FastAPI, which serves
# both that export at / and the API at /api. One image, one process, one
# origin — no CORS, no separate frontend deployment, and no backend URL baked
# into the JavaScript bundle.
#
# This is what Render (or Fly, Railway, Cloud Run, or `docker run`) deploys.
# The build context is the REPOSITORY ROOT, not backend/, because the image
# needs both halves:
#
#   docker build -t hazehub .
#   docker run -p 8000:8000 \
#       -e FIREBASE_PROJECT_ID=hazehub-8a941 \
#       -e FIREBASE_SERVICE_ACCOUNT="$(cat key.json)" \
#       hazehub

# --------------------------------------------------------------------------- #
# Stage 1 — the web app                                                        #
# --------------------------------------------------------------------------- #
FROM node:20-alpine AS web

WORKDIR /web
ENV NEXT_TELEMETRY_DISABLED=1

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
# Empty NEXT_PUBLIC_API_URL means "same origin". NEXT_PUBLIC_* is inlined at
# build time, so leaving it empty is what makes the image portable: the
# browser talks to whatever host it loaded the page from.
ENV NEXT_PUBLIC_API_URL="" \
    HAZEHUB_STATIC_EXPORT=1
RUN npm run build

# --------------------------------------------------------------------------- #
# Stage 2 — the server                                                         #
# --------------------------------------------------------------------------- #
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY backend/requirements.txt .
RUN pip install -r requirements.txt

COPY backend/app ./app
COPY --from=web /web/out ./web

# Where main.py looks for the built frontend.
ENV HAZEHUB_WEB_DIR=/app/web

# Render, Cloud Run and Fly all inject PORT; 8000 is the local default.
ENV PORT=8000
EXPOSE 8000

# One worker on purpose. The in-memory read cache is authoritative and assumes
# a single writer (see app/cache.py) — that is what keeps this inside
# Firestore's free daily quota. Scale with concurrency, never with processes
# or instances. If you must run more than one, set HAZEHUB_FIRESTORE_LISTEN=1
# first and re-read the notes in cache.py.
CMD exec uvicorn app.main:app \
    --host 0.0.0.0 --port ${PORT} --workers 1 \
    --proxy-headers --forwarded-allow-ips "*" \
    --timeout-keep-alive 75
