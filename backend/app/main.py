"""HazeHub FastAPI application.

This process is the whole server: the JSON API, the WebSocket hub, and —
when a built frontend is present — the web app itself. Serving both from one
origin is what lets HazeHub run on a laptop on the event LAN with no reverse
proxy, no CORS configuration, and no Cloud Run (so the Firebase project can
stay on the free Spark plan).
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import repo
from .config import settings
from .database import close_db, init_db
from .firestore_db import guard
from .firestore_db import status as firestore_status
from .realtime import hub
from .routers import admin, auth, betting, events, matches, picklists, scouting, sync, system, teams
from .seed import seed

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("hazehub")

STATIC_FIELD = Path(__file__).resolve().parent / "static_field"

#: The Next.js static export, if it has been built. Override with
#: HAZEHUB_WEB_DIR when the frontend lives somewhere else.
WEB_DIR = Path(
    os.getenv(
        "HAZEHUB_WEB_DIR",
        str(Path(__file__).resolve().parents[2] / "frontend" / "out"),
    )
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Best effort: a cold start with Firestore briefly unreachable should
    # still boot and serve /api/health with a clear diagnostic.
    #
    # init_db() loads the whole working set into memory. That is the single
    # burst of Firestore reads in a normal day — a few thousand documents,
    # once — and every request afterwards is served from RAM.
    try:
        init_db()
        seed()
    except Exception as exc:  # noqa: BLE001
        log.exception("startup failed: %s", exc)
    yield
    try:
        close_db()
    except Exception:  # noqa: BLE001
        pass


app = FastAPI(title="HazeHub API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    # Tablets reach the host laptop by whatever LAN address it has that day.
    allow_origin_regex=settings.cors_origin_regex,
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
    db = firestore_status()
    cache = repo.cache_stats()
    quota = guard.snapshot()
    out = {
        "ok": bool(cache.get("ready")),
        "app": settings.APP_NAME,
        "season": settings.SEASON,
        "environment": settings.ENVIRONMENT,
        "database": db,
        "cache": {
            "backend": cache.get("backend"),
            "documents": cache.get("cached_total"),
            "event": cache.get("event_key"),
        },
        "quota": {
            kind: f"{v['used']}/{v['budget']}" for kind, v in quota["operations"].items()
        },
        "realtime": "websocket (/ws) with polling fallback (/api/events)",
    }
    if cache.get("error"):
        out["error"] = cache["error"]
    if cache.get("backend") == "local-file":
        out["warning"] = (
            "Running on the local development store — data is NOT in Firestore. "
            "Set FIREBASE_PROJECT_ID (and FIREBASE_SERVICE_ACCOUNT outside Google "
            "Cloud), or FIRESTORE_EMULATOR_HOST for local emulator use. "
            "See instructions.txt."
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
    except Exception:  # noqa: BLE001
        await hub.disconnect(ws)


if STATIC_FIELD.exists():
    app.mount("/field", StaticFiles(directory=str(STATIC_FIELD)), name="field")


# --------------------------------------------------------------------------- #
# The web app                                                                  #
# --------------------------------------------------------------------------- #
if WEB_DIR.is_dir() and (WEB_DIR / "index.html").exists():
    # Next.js hashes its assets, so /_next/static can be cached forever.
    app.mount(
        "/_next", StaticFiles(directory=str(WEB_DIR / "_next")), name="next-assets"
    )

    def _resolve(rel: str) -> Path | None:
        """Map a URL path onto a file in the static export.

        `next build` with `output: "export"` emits `about.html` for /about and
        `about/index.html` when trailingSlash is on, so try both before
        falling back to the SPA shell.
        """
        rel = rel.strip("/")
        candidates = (
            [WEB_DIR / "index.html"]
            if not rel
            else [WEB_DIR / rel, WEB_DIR / f"{rel}.html", WEB_DIR / rel / "index.html"]
        )
        for candidate in candidates:
            try:
                resolved = candidate.resolve()
                # Never serve anything outside the export directory.
                resolved.relative_to(WEB_DIR.resolve())
            except (OSError, ValueError):
                continue
            if resolved.is_file():
                return resolved
        return None

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_web(full_path: str):
        """Serve the built web app for any non-API path.

        Registered last so every real route wins; unknown paths fall through
        to the app shell and the client router handles them.
        """
        target = _resolve(full_path) or (WEB_DIR / "404.html")
        if not target.is_file():
            target = WEB_DIR / "index.html"
        no_cache = target.suffix == ".html"
        return FileResponse(
            target,
            headers={"Cache-Control": "no-cache"} if no_cache else None,
        )

    log.info("serving the web app from %s", WEB_DIR)
else:
    log.info(
        "no built frontend at %s — API only. Build it with "
        "`cd frontend && npm run build` (HAZEHUB_STATIC_EXPORT=1) to serve "
        "everything from this one process.",
        WEB_DIR,
    )
