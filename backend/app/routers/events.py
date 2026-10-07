"""Polled realtime change feed: the fallback for /ws.

Clients that cannot hold a WebSocket open poll this endpoint with the cursor
from the previous response and dispatch the returned events onto the same
client-side bus. The feed is an in-process ring buffer (see ``realtime``), so
60 devices polling every five seconds costs zero Firestore operations.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import current_scouter
from ..models import Scouter
from ..realtime import events_since

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("")
def poll_events(
    since: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    return events_since(since)
