"""HazeHub FastAPI application (MongoDB edition).

Serverless-friendly: no in-process state, no WebSockets (clients poll
``/api/events``), and schema initialization is a cheap version check on warm
paths.  The same app runs locally under uvicorn and on Vercel as the
``backend`` service.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pymongo.errors import ConfigurationError, OperationFailure, PyMongoError

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

@app.exception_handler(PyMongoError)
async def mongo_error_handler(request: Request, exc: PyMongoError) -> JSONResponse:
    """Turn opaque 500s into an actionable 503 when MongoDB is the problem.

    On Vercel this almost always means MONGODB_URI isn't set (the default
    points at localhost) or the Atlas connection string / network access list
    is wrong.
    """
    if isinstance(exc, OperationFailure) and "auth" in str(exc).lower():
        detail = (
            f"MongoDB Atlas rejected the credentials for '{settings.mongodb_host}' "
            "(bad auth). The database user's password doesn't match MONGODB_URI — "
            "update the URI in Vercel (or reset the user's password in Atlas → "
            "Database Access), then redeploy."
        )
    elif isinstance(exc, ConfigurationError):
        detail = (
            "MongoDB connection string is invalid: "
            f"{exc}. Check the MONGODB_URI project setting."
        )
    elif settings.mongodb_is_default:
        detail = (
            "MONGODB_URI is not set on this deployment, so the backend is "
            "pointing at localhost. Add MONGODB_URI (a MongoDB Atlas "
            "mongodb+srv:// connection string) in Vercel → Project → "
            "Settings → Environment Variables, then redeploy."
        )
    else:
        detail = (
            f"Could not reach MongoDB at '{settings.mongodb_host}'. Check the "
            "username/password in MONGODB_URI and allow access from anywhere "
            "(0.0.0.0/0) in Atlas → Network Access."
        )
    return JSONResponse(status_code=503, content={"detail": detail})


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
        "mongodb": {
            "configured": not settings.mongodb_is_default,
            "host": settings.mongodb_host,
            "reachable": mongo_ok,
        },
        "realtime": "polling (/api/events)",
    }
