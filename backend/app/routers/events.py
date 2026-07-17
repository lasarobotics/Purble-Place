"""Polled realtime change feed — the WebSocket replacement.

Vercel functions cannot hold a WebSocket open, so clients poll this endpoint
every few seconds with the cursor from the previous response and dispatch the
returned events onto the same client-side bus the old socket fed.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pymongo.database import Database

from ..auth import current_scouter
from ..database import database_dependency
from ..realtime import events_since
from ..views import ScouterView

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("")
def poll_events(
    since: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict:
    return events_since(db, since)
