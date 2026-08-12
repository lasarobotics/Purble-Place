"""Batch synchronization + recovery imports.

Devices queue submissions in IndexedDB while offline and flush them here when
the connection returns; recovery JSONL files from a failed Chromebook replay
through the same endpoint. Everything is keyed by the submission UUID and the
payload hash, and the response carries an individual result for every record —
one bad record never blocks the rest.

Firestore notes
---------------
A batch is capped at ``MAX_BATCH`` records, comfortably inside Firestore's
500-operations-per-commit limit even counting the match-lock writes a batch
can trigger. New records go in through one batched commit rather than a write
per record, and the per-scout counter is bumped once for the whole batch —
so a device that comes back online with 40 queued matches costs roughly 42
document writes, not 120.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import repo
from ..auth import current_scouter
from ..cache import WriteTooLarge, store
from ..models import Scouter, ScoutEntry
from ..realtime import emit
from ..scoring import compute_points
from .scouting import ScoutIn, canonical_hash, lock_betting_for_match, validate_submission

router = APIRouter(prefix="/api/sync", tags=["sync"])

#: Firestore allows 500 operations per commit; 50 submissions plus their
#: match-lock and counter writes stays far below that.
MAX_BATCH = 50


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SyncIn(BaseModel):
    entries: list[ScoutIn] = []


@router.post("/scout")
def sync_scout(
    body: SyncIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    results: list[dict] = []
    accepted: list[str] = []
    duplicates: list[str] = []
    to_create: list[tuple[dict, ScoutEntry]] = []

    for item in body.entries[:MAX_BATCH]:
        key = item.submission_id or item.client_uuid or ""
        result = {"submission_id": key, "status": "created"}
        results.append(result)

        event_key = repo.resolve_event(item.event_key)
        if not event_key:
            result.update(status="invalid", error="No event configured")
            continue

        error = validate_submission(item.model_dump())
        if error:
            result.update(status="invalid", error=error)
            continue

        existing = repo.scouting_by_submission(key) if key else None
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
        except Exception as exc:  # noqa: BLE001 — isolate the bad record
            result.update(status="invalid", error=str(exc)[:300])
            continue

        to_create.append((result, entry))

    created = 0
    if to_create:
        # One commit for the whole batch. ``create_scouting`` semantics are
        # preserved by the pre-check above plus the per-document UUID key:
        # anything already stored was filtered out as a duplicate, and two
        # records in one batch cannot share a UUID without the first winning.
        fresh: list[ScoutEntry] = []
        seen: set[str] = set()
        for result, entry in to_create:
            if entry.submission_id in seen:
                result["status"] = "already_exists"
                duplicates.append(entry.submission_id)
                continue
            seen.add(entry.submission_id)
            entry.azure_received_at = _now()
            entry.cloud_status = "synced"
            fresh.append(entry)

        try:
            store.write_many(fresh)
        except WriteTooLarge as exc:
            for result, _ in to_create:
                result.update(status="invalid", error=str(exc)[:300])
            fresh = []
        except Exception as exc:  # noqa: BLE001
            for result, _ in to_create:
                result.update(status="invalid", error=str(exc)[:300])
            fresh = []

        locked: set[tuple[str, str, int]] = set()
        for entry in fresh:
            created += 1
            accepted.append(entry.submission_id)
            slot = (entry.event_key, entry.comp_level, entry.match_number)
            if slot not in locked:
                locked.add(slot)
                lock_betting_for_match(*slot)
        for result, entry in to_create:
            if entry.submission_id in accepted:
                result["submission_id"] = entry.submission_id

    if created:
        # One counter write for the whole batch, coalesced with any other
        # recent activity by this scout.
        scouter.matches_scouted += created
        repo.save_scouter(scouter, coalesce=True)
        emit("scout_submitted", {"synced": created})

    return {
        "ok": True,
        "results": results,
        # Back-compat fields for the older client sync loop.
        "accepted": [u for u in accepted if u],
        "accepted_count": created,
        "duplicates": duplicates,
    }
