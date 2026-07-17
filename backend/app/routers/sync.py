"""Offline sync: the Chromebook/phone queues entries in IndexedDB while the
connection is down and flushes them here when it returns.  Everything is keyed
by ``client_uuid`` so replays never duplicate."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from pymongo.database import Database

from ..auth import current_scouter
from ..database import database_dependency
from ..realtime import emit
from ..repositories import HazeHubRepository, RepositoryError
from ..store import get_setting
from ..views import ScouterView
from .scouting import ScoutIn, build_document, find_by_client_uuid

router = APIRouter(prefix="/api/sync", tags=["sync"])


class SyncIn(BaseModel):
    entries: list[ScoutIn] = []


@router.post("/scout")
def sync_scout(
    body: SyncIn,
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    repo = HazeHubRepository(db)
    accepted: list[str] = []
    duplicates: list[str] = []
    for item in body.entries:
        uuid = item.client_uuid
        if uuid and find_by_client_uuid(db, uuid) is not None:
            duplicates.append(uuid)
            continue
        event_key = (item.event_key or get_setting(db, "current_event")).strip()
        if not event_key:
            continue
        try:
            document = build_document(item, event_key, scouter.scout_id)
            repo.submit_match_scouting(document)
        except (ValueError, RepositoryError):
            # Racing duplicate or invalid entry — treat replays as duplicates
            # so the client clears them from its queue.
            if uuid and find_by_client_uuid(db, uuid) is not None:
                duplicates.append(uuid)
            continue
        accepted.append(uuid or "")

    if accepted:
        db.scouters.update_one(
            {"_id": scouter.scout_id},
            {"$inc": {"matches_scouted": len(accepted)}},
        )
        emit(db, "scout_submitted", {"synced": len(accepted)})
    return {
        "ok": True,
        "accepted": [u for u in accepted if u],
        "accepted_count": len(accepted),
        "duplicates": duplicates,
    }
