"""Realtime layer, serverless edition.

Vercel functions cannot hold WebSocket connections, so live updates are a
polled change feed instead: every data-changing endpoint appends an event to
the ``activity`` collection (TTL-expired after two hours) and clients poll
``GET /api/events?since=<cursor>`` every few seconds.  The payload shape is
identical to what the old WebSocket hub broadcast, so the frontend event bus
did not have to change.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pymongo.database import Database

from .models import ActivityDocument

MAX_EVENTS = 100


def _iso(dt: datetime) -> str:
    # "Z" instead of "+00:00": a "+" in a query string decodes to a space, so
    # cursors that round-trip through unencoded URLs would otherwise break.
    return dt.isoformat().replace("+00:00", "Z")


def _parse_cursor(since_iso: str) -> datetime | None:
    # Repair a "+00:00" offset that a URL decoder turned into " 00:00".
    candidate = since_iso.strip()
    if " " in candidate:
        candidate = candidate.replace(" ", "+")
    try:
        since = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if since.tzinfo is None:
        since = since.replace(tzinfo=UTC)
    return since


def emit(db: Database, event: str, payload: Any = None) -> None:
    """Append a change event. Best-effort: realtime must never fail a write."""
    try:
        db.activity.insert_one(ActivityDocument(event=event, payload=payload).to_bson())
    except Exception:
        pass


def events_since(db: Database, since_iso: str | None) -> dict[str, Any]:
    """Events newer than the ``since`` cursor plus a fresh cursor.

    The first poll (no cursor) returns no events — clients only care about
    changes that happen after they connect.
    """
    now = datetime.now(UTC)
    events: list[dict[str, Any]] = []
    since = _parse_cursor(since_iso) if since_iso else None
    if since is not None:
        newest = since
        cursor = (
            db.activity.find({"ts": {"$gt": since}})
            .sort("ts", 1)
            .limit(MAX_EVENTS)
        )
        for doc in cursor:
            ts = doc.get("ts") or now
            newest = max(newest, ts)
            events.append(
                {
                    "event": doc.get("event"),
                    "payload": doc.get("payload"),
                    "ts": _iso(ts),
                }
            )
        if events:
            # Advance the cursor to the newest delivered event so nothing is
            # skipped even if this poll raced a concurrent write.
            now = newest
    return {"now": _iso(now), "events": events}
