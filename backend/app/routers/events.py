"""Polled realtime change feed — the serverless fallback for /ws.

Vercel functions cannot hold a WebSocket open, so clients that fail to
connect to ``/ws`` poll this endpoint with the cursor from the previous
response and dispatch the returned events onto the same client-side bus.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session

from ..auth import current_scouter
from ..database import get_session
from ..models import Scouter
from ..realtime import events_since

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("")
def poll_events(
    since: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> dict:
    return events_since(session, since)
