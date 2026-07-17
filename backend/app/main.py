"""HazeHub FastAPI application (MongoDB edition).

Serverless-friendly: no in-process state, no WebSockets (clients poll
``/api/events``), and schema initialization is a cheap version check on warm
paths.  The same app runs locally under uvicorn and on Vercel as the
``backend`` service.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import ensure_schema
from app.routers import (
    admin,
    auth,
    betting,
    events,
    matches,
    picklists,
    scouting,
    sync,
    teams,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Best effort: a cold start with MongoDB briefly unreachable should still
    # boot and serve /api/health; the first real request will retry.
    try:
        ensure_schema()
    except Exception:
        pass
    yield


app = FastAPI(title="HazeHub API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (
    auth.router,
    teams.router,
    matches.router,
    scouting.router,
    scouting.pit_router,
    betting.router,
    picklists.router,
    admin.router,
    sync.router,
    events.router,
):
    app.include_router(r)


@app.get("/api/health")
def health() -> dict:
    mongo_ok = True
    try:
        ensure_schema()
    except Exception:
        mongo_ok = False
    return {
        "ok": mongo_ok,
        "app": settings.app_name,
        "season": settings.season,
        "environment": "vercel" if settings.is_vercel else "local",
        "database": "mongodb",
        "realtime": "polling (/api/events)",
    }
