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
from .routers import admin, auth, betting, matches, picklists, scouting, sync, teams
from .seed import seed

STATIC_FIELD = Path(__file__).resolve().parent / "static_field"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed()
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
):
    app.include_router(r)


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "app": settings.APP_NAME,
        "season": settings.SEASON,
        "environment": "azure" if settings.IS_AZURE else "local",
        "database": "postgres" if "postgres" in settings.DATABASE_URL else "sqlite",
    }


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
