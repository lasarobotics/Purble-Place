"""Realtime layer: WebSocket fan-out with a polled fallback.

``emit`` does two things for every change event:

1. Broadcasts to any connected ``/ws`` clients. Cloud Run holds WebSockets
   open (up to its request timeout), so this is the normal path.
2. Appends to an in-process ring buffer so clients that cannot hold a socket
   open can poll ``GET /api/events?since=<cursor>`` and replay the same
   ``(event, payload)`` pairs onto the same client-side bus.

Why the feed is not stored in Firestore
---------------------------------------
It used to be an ``activity`` table. In Firestore that would be one document
write per change plus one delete per expiry: roughly 4,000 write operations
and 4,000 deletes on a competition day, about 40% of the free daily
allowance, spent on data with a two-hour lifespan that nothing reads after
the fact. The feed is ephemeral by definition, so it lives in RAM: 60 clients
polling it costs nothing at all.

The trade-off is that the feed is per-instance, which is fine because the
write-through cache already requires the service to run as a single instance
(``--max-instances=1``). A client that reconnects to a fresh instance simply
starts from an empty cursor and refetches, exactly as it does today after a
deploy.
"""
from __future__ import annotations

import asyncio
import json
import threading
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import WebSocket

MAX_EVENTS = 100
#: Ring size. Two hours of events at competition pace is a few hundred rows.
RING_SIZE = 1000
RETENTION = timedelta(hours=2)


class Hub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, ws: WebSocket) -> None:
        self._loop = asyncio.get_running_loop()
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, event: str, payload: Any = None) -> None:
        message = json.dumps({"event": event, "payload": payload}, default=str)
        async with self._lock:
            targets = list(self._clients)
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(message)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)

    def client_count(self) -> int:
        return len(self._clients)

    def publish(self, event: str, payload: Any = None) -> None:
        """Schedule a broadcast from the event loop or a FastAPI worker thread."""
        try:
            asyncio.get_running_loop().create_task(self.broadcast(event, payload))
            return
        except RuntimeError:
            pass
        loop = self._loop
        if loop and loop.is_running():
            # Build the coroutine on the server loop. Creating it in this
            # worker thread can leak an un-awaited coroutine during shutdown.
            loop.call_soon_threadsafe(
                lambda: loop.create_task(self.broadcast(event, payload))
            )


hub = Hub()


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# In-memory activity ring                                                      #
# --------------------------------------------------------------------------- #
_ring: deque[dict[str, Any]] = deque(maxlen=RING_SIZE)
_ring_lock = threading.Lock()


def _record(event: str, payload: Any) -> None:
    row = {"event": event, "payload": payload or {}, "ts": _now()}
    cutoff = _now() - RETENTION
    with _ring_lock:
        _ring.append(row)
        while _ring and _ring[0]["ts"] < cutoff:
            _ring.popleft()


def emit(event: str, payload: Any = None) -> None:
    """Fire-and-forget broadcast, usable from sync request handlers."""
    _record(event, payload)
    hub.publish(event, payload)


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


def events_since(since_iso: str | None) -> dict[str, Any]:
    """Events newer than the ``since`` cursor, plus a fresh cursor.

    The first poll (no cursor) returns no events: clients only care about
    changes that happen after they connect.
    """
    now = _now()
    events: list[dict[str, Any]] = []
    since = _parse_cursor(since_iso) if since_iso else None
    if since is not None:
        newest = since
        with _ring_lock:
            rows = [r for r in _ring if r["ts"] > since][:MAX_EVENTS]
        for row in rows:
            newest = max(newest, row["ts"])
            events.append(
                {"event": row["event"], "payload": row["payload"], "ts": _iso(row["ts"])}
            )
        if events:
            now = newest
    return {"now": _iso(now), "events": events}


def buffered_count() -> int:
    with _ring_lock:
        return len(_ring)
