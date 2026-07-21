"""Batch synchronization + recovery imports.

Devices queue submissions in IndexedDB while offline and flush them here when
the connection returns; recovery JSONL files from a failed Chromebook replay
through the same endpoint. Everything is keyed by the submission UUID and the
payload hash, and the response carries an individual result for every record —
one bad record never blocks the rest.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import current_scouter
from ..database import get_session
from ..models import MatchRecord, Scouter, ScoutEntry
from ..realtime import emit
from ..scoring import compute_points
from ..store import get_setting
from .scouting import ScoutIn, canonical_hash, validate_submission

router = APIRouter(prefix="/api/sync", tags=["sync"])

MAX_BATCH = 50


class SyncIn(BaseModel):
    entries: list[ScoutIn] = []


@router.post("/scout")
def sync_scout(
    body: SyncIn,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    results: list[dict] = []
    accepted: list[str] = []
    duplicates: list[str] = []
    created = 0

    for item in body.entries[:MAX_BATCH]:
        key = item.submission_id or item.client_uuid or ""
        result = {"submission_id": key, "status": "created"}
        results.append(result)

        event_key = (item.event_key or get_setting(session, "current_event")).strip()
        if not event_key:
            result.update(status="invalid", error="No event configured")
            continue

        error = validate_submission(item.model_dump())
        if error:
            result.update(status="invalid", error=error)
            continue

        existing = None
        if key:
            existing = session.exec(
                select(ScoutEntry).where(
                    (ScoutEntry.submission_id == key) | (ScoutEntry.client_uuid == key)
                )
            ).first()
        if existing is not None:
            if (
                item.payload_hash
                and existing.payload_hash
                and item.payload_hash != existing.payload_hash
            ):
                result.update(
                    status="conflict",
                    error="UUID exists with a different payload",
                )
            else:
                result["status"] = "already_exists"
                duplicates.append(key)
            continue

        try:
            data = item.model_dump()
            data["event_key"] = event_key
            data["scout_id"] = scouter.scout_id
            data["points"] = 0.0 if item.no_show else compute_points(data)
            if not data.get("payload_hash"):
                data["payload_hash"] = canonical_hash(data)
            entry = ScoutEntry.from_submission(data)
            session.add(entry)
            # First scouting on a match closes its betting window (parity with
            # the single-submit path).
            match = session.exec(
                select(MatchRecord).where(
                    MatchRecord.event_key == event_key,
                    MatchRecord.comp_level == entry.comp_level,
                    MatchRecord.match_number == entry.match_number,
                )
            ).first()
            if match and not match.betting_locked:
                match.betting_locked = True
                session.add(match)
            session.commit()
        except Exception as exc:  # noqa: BLE001 — isolate the bad record
            session.rollback()
            result.update(status="invalid", error=str(exc)[:300])
            continue

        created += 1
        accepted.append(key or entry.submission_id)
        result["submission_id"] = entry.submission_id

    if created:
        session.add(scouter)
        scouter.matches_scouted += created
        session.commit()
        emit("scout_submitted", {"synced": created})

    return {
        "ok": True,
        "results": results,
        # Back-compat fields for the older client sync loop.
        "accepted": [u for u in accepted if u],
        "accepted_count": created,
        "duplicates": duplicates,
    }
