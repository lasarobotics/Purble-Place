"""HazeHub FastAPI application.

This process is the whole server: the JSON API, the WebSocket hub, and: when a built frontend is present: the web app itself. Serving both from one
origin is what lets HazeHub run on a laptop on the event LAN with no reverse
proxy, no CORS configuration, and no Cloud Run (so the Firebase project can
stay on the free Spark plan).
"""
from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi.middleware.gzip import GZipMiddleware
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import repo
from .cache import StoreUnavailable
from .config import settings
from .database import close_db, init_db
from .realtime import hub
from .routers import pages, accounts, pits
from .routers import (
    admin, auth, betting, events, forms, matches, picklists, scouting, seasons,
    sync, system, teams,
)
from .form_store import seed_builtin_forms
from .seasons import seed_first_season
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
    # burst of Firestore reads in a normal day: a few thousand documents,
    # once: and every request afterwards is served from RAM.
    try:
        init_db()
        seed()
        # A season owns the game, the forms and everything scouted under
        # them, so it has to exist before any of those are looked up.
        seed_first_season()
        # The scouting and pit pages render from these, so a fresh install
        # needs them before anyone signs in.
        seed_builtin_forms()
        # The event pointer decides what every screen shows. If it has gone
        # stale the app looks empty while the data sits in the datastore under
        # another key, so it is checked here rather than discovered at an event.
        repo.reconcile_current_event()
    except Exception as exc:  # noqa: BLE001
        log.exception("startup failed: %s", exc)
    from .heatmap_migration import migrate_heatmap_shots, migrate_epa_scores
    migrate_heatmap_shots()
    migrate_epa_scores()
    yield
    try:
        close_db()
    except Exception:  # noqa: BLE001
        pass


app = FastAPI(title="HazeHub API", version="2.0.0", lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    # Tablets reach the host laptop by whatever LAN address it has that day.
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


POST_COMP_COOKIE = "post_comp_unlocked"
POST_COMP_404 = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>404: This page could not be found</title>
  <style>
    html,body{height:100%;margin:0;background:#1f1f1f;color:#ededed;font:16px/1.5 Arial,Helvetica,sans-serif}
    body{display:grid;place-items:center}
    main{display:flex;align-items:center;gap:22px}
    h1{font-size:24px;line-height:1;margin:0;padding-right:22px;border-right:1px solid #555}
    p{margin:0;font-size:14px;color:#cfcfcf}
  </style>
</head>
<body>
  <main aria-label="404 error">
    <h1>404</h1>
    <p>This page could not be found.</p>
  </main>
  <script>
    (function () {
      var want = ["ArrowLeft","ArrowLeft","ArrowRight","ArrowRight","4","1","8","Control","Control"];
      var at = 0;
      function keyName(event) {
        if (event.key === "Control" || event.code === "ControlLeft" || event.code === "ControlRight") return "Control";
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") return event.key;
        if (event.key === "4" || event.code === "Digit4" || event.code === "Numpad4") return "4";
        if (event.key === "1" || event.code === "Digit1" || event.code === "Numpad1") return "1";
        if (event.key === "8" || event.code === "Digit8" || event.code === "Numpad8") return "8";
        return event.key;
      }
      window.addEventListener("keydown", function (event) {
        var key = keyName(event);
        if (key === want[at]) at += 1;
        else at = key === want[0] ? 1 : 0;
        if (at === want.length) {
          document.cookie = "post_comp_unlocked=1; Max-Age=86400; Path=/; SameSite=Lax";
          try { window.localStorage.setItem("hazehub.post_comp_unlocked", "1"); } catch (e) {}
          window.location.href = "/login";
        }
      });
    }());
  </script>
</body>
</html>
"""


def _post_comp_locked(request: Request) -> bool:
    if repo.setting("post_comp_mode") != "1":
        return False
    return request.cookies.get(POST_COMP_COOKIE) != "1"


@app.middleware("http")
async def post_comp_gate(request: Request, call_next):
    # Liveness must not wait for the datastore lock or its connectivity probe.
    if request.url.path == "/api/health":
        return await call_next(request)
    if _post_comp_locked(request):
        path = request.url.path
        if path.startswith("/api/"):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        return HTMLResponse(POST_COMP_404, status_code=404)
    response = await call_next(request)
    if request.url.path.startswith("/api/auth/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.middleware("http")
async def request_duration(request: Request, call_next):
    started = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        response.headers["Server-Timing"] = f"app;dur={(time.perf_counter() - started) * 1000:.2f}"
        return response
    finally:
        elapsed_ms = (time.perf_counter() - started) * 1000
        route = request.scope.get("route")
        if request.url.path.startswith("/api/"):
            # Route templates avoid logging IDs, query strings, credentials or bodies.
            log.log(logging.WARNING if elapsed_ms >= 1000 else logging.INFO,
                    "request method=%s route=%s status=%s duration_ms=%.2f",
                    request.method, getattr(route, "path", "unmatched"), status_code, elapsed_ms)

for r in (
    pages.router,
    pits.router,
    accounts.router,
    auth.router,
    auth.game_router,
    teams.router,
    matches.router,
    scouting.router,
    scouting.pit_router,
    betting.router,
    picklists.router,
    forms.router,
    seasons.router,
    admin.router,
    sync.router,
    system.router,
    events.router,
):
    app.include_router(r)


@app.exception_handler(StoreUnavailable)
def _datastore_unavailable(request: Request, exc: StoreUnavailable) -> JSONResponse:
    """Answer 503, not 500, when the datastore is unreachable.

    This matters for scouting: a tablet treats 5xx as "retry later" and keeps
    the submission queued, but 503 plus a real explanation is the difference
    between someone diagnosing a bad credential in a minute and staring at an
    opaque "Internal Server Error" for an hour.
    """
    log.error("datastore unavailable on %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=503,
        content={
            "detail": (
                "The database is unreachable, so this could not be saved. "
                "Your device has kept it queued and will retry. "
                f"Cause: {exc}"
            ),
            "retry": True,
        },
    )


@app.get("/api/health")
async def health() -> dict:
    # Primitive cached state only: no thread-pool slot, locks or network calls.
    # Detailed connectivity/quota diagnostics remain in protected System Health.
    return {"ok": bool(repo.store.ready), "app": settings.APP_NAME,
            "season": settings.SEASON, "environment": settings.ENVIRONMENT}


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


# Preserve authoring implementations, but do not serve these disabled pages.
@app.api_route("/admin/forms", methods=["GET", "HEAD"], include_in_schema=False)
@app.api_route("/admin/seasons", methods=["GET", "HEAD"], include_in_schema=False)
@app.api_route("/admin/forms/", methods=["GET", "HEAD"], include_in_schema=False)
@app.api_route("/admin/seasons/", methods=["GET", "HEAD"], include_in_schema=False)
def disabled_authoring_page():
    raise HTTPException(status_code=404, detail="This tool is temporarily disabled")


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

    #: Extensions that must never fall through to the app shell. A missing
    #: chunk answered with 200 + HTML looks like a working deploy while the
    #: page silently fails; a real 404 says what actually happened.
    _ASSET_SUFFIXES = {
        ".js", ".css", ".map", ".json", ".txt", ".woff", ".woff2", ".ttf",
        ".otf", ".eot", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
        ".ico", ".mp4", ".webm", ".xml", ".wasm",
    }

    # HEAD as well as GET: uptime checkers and platform probes send HEAD to /,
    # and FastAPI does not derive it from a GET route. Answering 405 makes a
    # healthy service look unhealthy to whatever is watching it.
    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def serve_web(full_path: str):
        """Serve the built web app for any non-API path.

        Registered last so every real route wins; unknown *page* paths fall
        through to the app shell and the client router handles them.
        """
        target = _resolve(full_path)
        if target is None:
            suffix = Path(full_path).suffix.lower()
            if suffix and suffix in _ASSET_SUFFIXES:
                raise HTTPException(status_code=404, detail="Not found")
            target = WEB_DIR / "404.html"
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
        "no built frontend at %s: API only. Build it with "
        "`cd frontend && npm run build` (HAZEHUB_STATIC_EXPORT=1) to serve "
        "everything from this one process.",
        WEB_DIR,
    )
