"""Realtime layer — WebSocket fan-out with a polled fallback.

``emit`` does two things for every change event:

1. Broadcasts to any connected ``/ws`` clients (works locally and on
   always-on hosts; free instant updates on the event LAN).
2. Appends an ``activity`` row so serverless deployments (Vercel cannot hold
   a WebSocket open) can serve ``GET /api/events?since=<cursor>`` and clients
   poll the exact same (event, payload) pairs.

The frontend tries the WebSocket first and falls back to polling, so one
client build works against both hosting models.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import WebSocket
from sqlmodel import Session, select

MAX_EVENTS = 100
RETENTION = timedelta(hours=2)


class Hub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, event: str, payload: Any = None) -> None:
        message = json.dumps({"event": event, "payload": payload})
        async with self._lock:
            targets = list(self._clients)
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)


hub = Hub()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _record(event: str, payload: Any) -> None:
    """Persist the event for pollers. Best-effort: realtime must never fail a
    write, and each emit is rare enough that a short-lived session is fine."""
    from .database import engine
    from .models import Activity

    try:
        with Session(engine) as session:
            session.add(Activity(event=event, payload=payload or {}))
            # Lazy pruning keeps the table tiny without a background job.
            cutoff = _now() - RETENTION
            for stale in session.exec(select(Activity).where(Activity.ts < cutoff)).all():
                session.delete(stale)
            session.commit()
    except Exception:
        pass


def emit(event: str, payload: Any = None) -> None:
    """Fire-and-forget broadcast usable from sync request handlers."""
    _record(event, payload)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(hub.broadcast(event, payload))


# --------------------------------------------------------------------------- #
# Polled feed                                                                  #
# --------------------------------------------------------------------------- #
def _iso(dt: datetime) -> str:
    # "Z" instead of "+00:00": a "+" in a query string decodes to a space, so
    # cursors that round-trip through unencoded URLs would otherwise break.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _parse_cursor(since_iso: str) -> datetime | None:
    candidate = since_iso.strip()
    if " " in candidate:  # repair a "+00:00" that a URL decoder space-mangled
        candidate = candidate.replace(" ", "+")
    try:
        since = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except ValueError:
        return None
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    return since


def events_since(session: Session, since_iso: str | None) -> dict[str, Any]:
    """Events newer than the ``since`` cursor plus a fresh cursor.

    The first poll (no cursor) returns no events — clients only care about
    changes that happen after they connect.
    """
    from .models import Activity

    now = _now()
    events: list[dict[str, Any]] = []
    since = _parse_cursor(since_iso) if since_iso else None
    if since is not None:
        newest = since
        rows = session.exec(
            select(Activity).where(Activity.ts > since).order_by(Activity.ts).limit(MAX_EVENTS)
        ).all()
        for row in rows:
            ts = row.ts if row.ts.tzinfo else row.ts.replace(tzinfo=timezone.utc)
            newest = max(newest, ts)
            events.append({"event": row.event, "payload": row.payload, "ts": _iso(ts)})
        if events:
            now = newest
    return {"now": _iso(now), "events": events}
