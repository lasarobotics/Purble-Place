"""Offline sync: the Chromebook/phone queues entries in IndexedDB while the
connection is down and flushes them here when it returns.  Everything is keyed
by ``client_uuid`` so replays never duplicate."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import current_scouter
from ..database import get_session
from ..models import Scouter, ScoutEntry, TeamCache
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
    accepted: list[str] = []
    duplicates: list[str] = []
    for item in body.entries:
        uuid = item.client_uuid
        if uuid:
            existing = session.exec(
                select(ScoutEntry).where(ScoutEntry.client_uuid == uuid)
            ).first()
            if existing:
                duplicates.append(uuid)
                continue
        data = item.model_dump()
        data["event_key"] = (item.event_key or get_setting(session, "current_event")).strip()
        data["scout_id"] = scouter.scout_id
        entry = ScoutEntry(**{**data, "points": compute_points(data)})
        session.add(entry)
        scouter.matches_scouted += 1
        accepted.append(uuid or "")
    session.add(scouter)
    session.commit()
    if accepted:
        emit("scout_submitted", {"synced": len(accepted)})
    return {
        "ok": True,
        "accepted": [u for u in accepted if u],
        "accepted_count": len(accepted),
        "duplicates": duplicates,
    }
