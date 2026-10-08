"""Offline sync: the Chromebook/phone queues entries in IndexedDB while the
connection is down and flushes them here when it returns.  Everything is keyed
by ``client_uuid`` so replays never duplicate."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from pymongo.errors import BulkWriteError
from pymongo.database import Database

from ..auth import current_scouter
from ..database import database_dependency
from ..realtime import emit
from ..views import ScouterView
from .scouting import ScoutIn, build_document

router = APIRouter(prefix="/api/sync", tags=["sync"])


class SyncIn(BaseModel):
    entries: list[ScoutIn] = Field(default_factory=list, max_length=100)


@router.post("/scout")
def sync_scout(
    body: SyncIn,
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    accepted: list[str] = []
    duplicates: list[str] = []
    rejected: dict[str, str] = {}
    ids = [item.client_uuid for item in body.entries if item.client_uuid]
    existing = {doc["client_submission_id"]: doc for doc in db.match_scouting.find(
        {"client_submission_id": {"$in": ids}}, {"client_submission_id": 1, "scouter_id": 1, "match_key": 1, "event_key": 1})}
    documents = []
    seen = set()
    for item in body.entries:
        uuid = item.client_uuid
        if not uuid:
            continue
        if uuid in existing:
            if existing[uuid].get("scouter_id") == scouter.scout_id:
                duplicates.append(uuid)
            else:
                rejected[uuid] = "Submission identifier belongs to another scout"
            continue
        if uuid in seen:
            continue
        seen.add(uuid)
        # Never attach an offline report to whichever event happens to be current.
        if not item.event_key or not item.event_key.strip():
            rejected[uuid] = "Choose the original event before retrying this report"
            continue
        try:
            documents.append(build_document(item, item.event_key.strip(), scouter.scout_id).to_bson())
        except ValueError as exc:
            rejected[uuid] = str(exc)

    matches = {doc["_id"]: doc for doc in db.matches.find(
        {"_id": {"$in": list({d["match_key"] for d in documents})}})} if documents else {}
    valid = []
    for doc in documents:
        match = matches.get(doc["match_key"])
        teams = ((match or {}).get("alliances") or {}).get(doc["alliance"], {}).get("teams", [])
        if match and doc["team_num"] not in teams:
            rejected[doc["client_submission_id"]] = "Team is not on the selected alliance; correct the report"
        else:
            valid.append(doc)
    successful = list(valid)
    if valid:
        try:
            db.match_scouting.insert_many(valid, ordered=False)
        except BulkWriteError as exc:
            # An uncertain acknowledgement is retried with the same UUIDs.
            if exc.details.get("writeConcernErrors"):
                raise
            errors = {error["index"]: error for error in exc.details.get("writeErrors", [])}
            successful = [doc for i, doc in enumerate(valid) if i not in errors]
            raced_ids = [valid[i]["client_submission_id"] for i, error in errors.items() if error.get("code") == 11000]
            raced = {d["client_submission_id"] for d in db.match_scouting.find(
                {"client_submission_id": {"$in": raced_ids}, "scouter_id": scouter.scout_id}, {"client_submission_id": 1})}
            for i, error in errors.items():
                uuid = valid[i]["client_submission_id"]
                if uuid in raced:
                    duplicates.append(uuid)
                elif error.get("code") in (11000, 121):
                    rejected[uuid] = "Report conflicts with an existing submission" if error.get("code") == 11000 else "Report failed validation; review and retry"
        accepted = [doc["client_submission_id"] for doc in successful]
    # Recover locks on replays too, even if the first response was lost.
    done_ids = set(accepted + duplicates)
    done_docs = [d for d in valid + list(existing.values()) if d["client_submission_id"] in done_ids]
    lock_keys = {d["match_key"] for d in done_docs if d.get("match_key")}
    if lock_keys:
        db.matches.update_many({"_id": {"$in": list(lock_keys)}, "betting_locked": {"$ne": True}},
                               {"$set": {"betting_locked": True}})
    if accepted:
        db.scouters.update_one({"_id": scouter.scout_id}, {"$inc": {"matches_scouted": len(accepted)}})
    if accepted or duplicates:
        emit(db, "scout_submitted", {"synced": len(accepted), "events": list({d["event_key"] for d in done_docs if d.get("event_key")})})
    return {"ok": True, "accepted": accepted, "accepted_count": len(accepted),
            "duplicates": duplicates, "rejected": rejected}
