"""Offline sync: the Chromebook/phone queues entries in IndexedDB while the
connection is down and flushes them here when it returns.  Everything is keyed
by ``client_uuid`` so replays never duplicate."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import current_scouter
from ..database import get_session
from ..models import Scouter, ScoutEntry
from ..outbox import commit_submission
from ..realtime import emit
from ..scoring import compute_points
from ..store import get_setting
from .scouting import ScoutIn

router = APIRouter(prefix="/api/sync", tags=["sync"])


class SyncIn(BaseModel):
    entries: list[ScoutIn] = []


@router.post("/scout")
def sync_scout(
    body: SyncIn,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    """Replay the device's IndexedDB queue.

    Idempotent by ``submission_id`` (a.k.a. ``client_uuid``): a record already
    on MegaScout is reported as a duplicate so the device can clear it, exactly
    like a fresh submit. Each accepted entry goes through the transactional
    outbox, so replayed records are queued for Azure too.
    """
    accepted: list[str] = []
    duplicates: list[str] = []
    for item in body.entries:
        key = item.submission_id or item.client_uuid
        if key:
            existing = session.exec(
                select(ScoutEntry).where(
                    (ScoutEntry.submission_id == key) | (ScoutEntry.client_uuid == key)
                )
            ).first()
            if existing:
                duplicates.append(key)
                continue
        data = item.model_dump()
        data["event_key"] = (item.event_key or get_setting(session, "current_event")).strip()
        data["scout_id"] = scouter.scout_id
        data["points"] = 0.0 if item.no_show else compute_points(data)
        entry = ScoutEntry.from_submission(data)
        scouter.matches_scouted += 1
        session.add(scouter)
        commit_submission(session, entry)
        accepted.append(key or entry.submission_id)
    if accepted:
        emit("scout_submitted", {"synced": len(accepted)})
    return {
        "ok": True,
        "accepted": [u for u in accepted if u],
        "accepted_count": len(accepted),
        "duplicates": duplicates,
    }
