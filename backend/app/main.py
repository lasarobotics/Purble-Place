"""HazeHub FastAPI application."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import settings
from .database import init_db
from .realtime import hub
from .routers import admin, auth, betting, events, matches, picklists, scouting, sync, system, teams
from .seed import seed

STATIC_FIELD = Path(__file__).resolve().parent / "static_field"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Best effort: a cold start with the database briefly unreachable should
    # still boot and serve /api/health with a clear diagnostic.
    try:
        init_db()
        seed()
    except Exception:
        pass
    yield


app = FastAPI(title="HazeHub API", version="1.0.0", lifespan=lifespan)

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
    system.router,
    events.router,
):
    app.include_router(r)


@app.get("/api/health")
def health() -> dict:
    db_ok = True
    try:
        from sqlalchemy import text

        from .database import engine

        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    environment = "vercel" if settings.IS_VERCEL else ("azure" if settings.IS_AZURE else "local")
    out = {
        "ok": db_ok,
        "app": settings.APP_NAME,
        "season": settings.SEASON,
        "environment": environment,
        "database": {
            "engine": "postgres" if "postgres" in settings.DATABASE_URL else "sqlite",
            "configured": settings.DATABASE_CONFIGURED,
            "reachable": db_ok,
        },
        "realtime": "websocket (/ws) with polling fallback (/api/events)",
    }
    if settings.IS_VERCEL and not settings.DATABASE_CONFIGURED:
        out["warning"] = (
            "DATABASE_URL is not set — data will NOT persist. Add a cloud "
            "PostgreSQL connection string (e.g. Neon or Azure Database for "
            "PostgreSQL) in Vercel → Project → Settings → Environment "
            "Variables, then redeploy."
        )
    return out


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await hub.connect(ws)
    try:
        while True:
            # We only push; keep the socket open and ignore inbound pings.
            await ws.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(ws)
    except Exception:
        await hub.disconnect(ws)


if STATIC_FIELD.exists():
    app.mount("/field", StaticFiles(directory=str(STATIC_FIELD)), name="field")
