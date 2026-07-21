"""Match scouting + pit scouting.

Submissions follow the direct-to-cloud contract: the device assigns a UUID and
a SHA-256 payload hash; the server commits exactly once, returns the original
acknowledgement for identical retries, and 409s a UUID reused with a different
payload (corrections must be new records that supersede the original).
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..auth import current_scouter
from ..database import get_session
from ..external import sync_team
from ..models import MatchRecord, PitEntry, Scouter, ScoutEntry, TeamCache
from ..realtime import emit
from ..scoring import compute_points
from ..store import get_setting

router = APIRouter(prefix="/api/scout", tags=["scouting"])

# Fields that define the observation itself (identity + payload). The server
# hashes these for clients that didn't send a hash of their own.
_HASHED_FIELDS = (
    "event_key", "match_number", "comp_level", "team_number", "alliance",
    "station", "heatmap", "auto_leave", "auto_climb", "climb", "climb_seconds",
    "tags", "played_defense", "defense_rating", "defense_on",
    "successful_stops", "driver_skill", "speed_rating", "fouls",
    "failure", "failure_details", "no_show", "notes",
)


def canonical_hash(data: dict[str, Any]) -> str:
    """SHA-256 of the canonical (sorted-keys) JSON of the observation."""
    subset = {k: data.get(k) for k in _HASHED_FIELDS}
    canonical = json.dumps(subset, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate_submission(data: dict[str, Any]) -> str | None:
    """Field validation shared by the single and batch paths.

    Returns an error string (or None). Kept out of the Pydantic model on
    purpose: one invalid record in a batch must fail individually, not 422 the
    whole request.
    """
    try:
        if int(data.get("match_number") or 0) < 1:
            return "match_number must be at least 1"
        if int(data.get("team_number") or 0) < 1:
            return "team_number must be at least 1"
        if not 1 <= int(data.get("station") or 1) <= 3:
            return "station must be 1-3"
    except (TypeError, ValueError):
        return "match_number/team_number/station must be integers"
    if data.get("alliance") not in ("red", "blue"):
        return "alliance must be red or blue"
    if data.get("comp_level") not in ("qm", "qf", "sf", "f"):
        return "comp_level must be qm/qf/sf/f"
    if len(str(data.get("notes") or "")) > 5000:
        return "notes over maximum length (5000)"
    return None


class ScoutIn(BaseModel):
    client_uuid: Optional[str] = None
    # Canonical idempotency key assigned on the device (falls back to
    # client_uuid, then a server-generated UUID, for older clients).
    submission_id: Optional[str] = None
    # When the device created the record (ISO 8601). Preserved through sync so
    # the cloud keeps the true observation time even for records synced late.
    client_ts: Optional[str] = None
    # SHA-256 of the canonical payload, computed on the device.
    payload_hash: Optional[str] = None
    schema_version: int = 1
    # Corrections: a new UUID that supersedes an acknowledged record.
    supersedes_submission_id: Optional[str] = None
    event_key: Optional[str] = None
    match_number: int
    comp_level: str = "qm"
    team_number: int
    alliance: str = "red"
    station: int = 1

    auto_leave: bool = False
    auto_climb: bool = False
    heatmap: list[dict[str, Any]] = Field(default_factory=list)

    climb: str = "none"
    climb_seconds: Optional[float] = None

    tags: list[str] = Field(default_factory=list)
    played_defense: bool = False
    defense_rating: int = 0
    defense_on: str = ""
    successful_stops: int = 0
    driver_skill: int = 3
    speed_rating: int = 3
    fouls: int = 0
    failure: bool = False
    failure_details: str = ""
    no_show: bool = False
    notes: str = ""


def _entry_dict(e: ScoutEntry) -> dict:
    return {
        "id": e.id,
        "client_uuid": e.client_uuid,
        "event_key": e.event_key,
        "match_number": e.match_number,
        "comp_level": e.comp_level,
        "team_number": e.team_number,
        "alliance": e.alliance,
        "station": e.station,
        "scout_id": e.scout_id,
        "auto_leave": e.auto_leave,
        "auto_climb": e.auto_climb,
        "heatmap": e.heatmap,
        "climb": e.climb,
        "climb_seconds": e.climb_seconds,
        "tags": e.tags or [],
        "played_defense": e.played_defense,
        "defense_rating": e.defense_rating,
        "defense_on": e.defense_on,
        "successful_stops": e.successful_stops,
        "driver_skill": e.driver_skill,
        "speed_rating": e.speed_rating,
        "fouls": e.fouls,
        "failure": e.failure,
        "failure_details": e.failure_details,
        "no_show": e.no_show,
        "notes": e.notes,
        "points": e.points,
        "created_at": e.created_at.isoformat(),
        # Direct-to-cloud submission envelope. A record in this API *is* in
        # the cloud, so its status is always "synced" from the server's view;
        # the device's own queue tracks anything not yet committed here.
        "submission_id": e.submission_id,
        "client_ts": e.client_ts.isoformat() if e.client_ts else None,
        "azure_received_at": e.azure_received_at.isoformat() if e.azure_received_at else None,
        "payload_hash": e.payload_hash,
        "schema_version": e.schema_version,
        "supersedes_submission_id": e.supersedes_submission_id,
        "cloud_status": "synced",
    }


@router.post("")
async def submit_scout(
    body: ScoutIn,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    event_key = (body.event_key or get_setting(session, "current_event")).strip()

    error = validate_submission(body.model_dump())
    if error:
        raise HTTPException(status_code=422, detail=error)

    # Direct-to-cloud idempotency (PUT semantics on the submission UUID):
    #   same UUID + same payload hash      → return the original acknowledgement
    #   same UUID + different payload hash → 409, never overwrite
    key = body.submission_id or body.client_uuid
    if key:
        existing = session.exec(
            select(ScoutEntry).where(
                (ScoutEntry.submission_id == key) | (ScoutEntry.client_uuid == key)
            )
        ).first()
        if existing:
            if (
                body.payload_hash
                and existing.payload_hash
                and body.payload_hash != existing.payload_hash
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Submission UUID exists with a different payload — "
                    "submit a correction instead of overwriting",
                )
            return {"ok": True, "duplicate": True, "entry": _entry_dict(existing)}

    data = body.model_dump()
    data["event_key"] = event_key
    data["scout_id"] = scouter.scout_id
    # A no-show robot scores nothing regardless of stray taps.
    data["points"] = 0.0 if body.no_show else compute_points(data)
    if not data.get("payload_hash"):
        # Older clients don't hash; compute one server-side so later retries
        # and recovery imports can still be conflict-checked.
        data["payload_hash"] = canonical_hash(data)

    entry = ScoutEntry.from_submission(data)

    scouter.matches_scouted += 1
    session.add(scouter)

    match = session.exec(
        select(MatchRecord).where(
            MatchRecord.event_key == event_key,
            MatchRecord.comp_level == body.comp_level,
            MatchRecord.match_number == body.match_number,
        )
    ).first()
    if match and not match.betting_locked:
        match.betting_locked = True
        session.add(match)

    session.add(entry)
    session.commit()
    session.refresh(entry)

    # Warm the team cache the first time we see a team (best effort).
    if session.get(TeamCache, body.team_number) is None:
        try:
            await sync_team(session, body.team_number)
        except Exception:
            pass

    # Acknowledgement: the record is committed to the shared database — the
    # device can mark it "acknowledged"; every dashboard refetches.
    emit("submission_ack", {
        "submission_id": entry.submission_id,
        "id": entry.id,
        "azure_received_at": entry.azure_received_at.isoformat(),
    })
    emit("scout_submitted", {"team": entry.team_number, "match": entry.match_number, "bets_locked": bool(match)})
    return {"ok": True, "duplicate": False, "entry": _entry_dict(entry)}


@router.get("/mine")
def my_entries(
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> list[dict]:
    rows = session.exec(
        select(ScoutEntry)
        .where(ScoutEntry.scout_id == scouter.scout_id)
        .order_by(ScoutEntry.id.desc())
    ).all()
    return [_entry_dict(e) for e in rows]


@router.get("/last-assignment")
def last_assignment(
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    """Remember the scouter's last alliance + station so the next match
    auto-fills the same slot (they can still change it)."""
    last = session.exec(
        select(ScoutEntry)
        .where(ScoutEntry.scout_id == scouter.scout_id)
        .order_by(ScoutEntry.id.desc())
    ).first()
    if not last:
        return {"alliance": "red", "station": 1}
    return {"alliance": last.alliance, "station": last.station}


@router.get("/match/{match_number}")
def entries_for_match(
    match_number: int,
    event: str | None = None,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> list[dict]:
    event_key = (event or get_setting(session, "current_event")).strip()
    rows = session.exec(
        select(ScoutEntry).where(
            ScoutEntry.event_key == event_key,
            ScoutEntry.match_number == match_number,
        )
    ).all()
    return [_entry_dict(e) for e in rows]


# --------------------------------------------------------------------------- #
# Pit scouting                                                                 #
# --------------------------------------------------------------------------- #
class PitIn(BaseModel):
    event_key: Optional[str] = None
    team_number: int
    drivetrain: str = ""
    weight_lbs: Optional[float] = None
    width_in: Optional[float] = None
    length_in: Optional[float] = None
    can_climb: str = "none"
    auto_routine: str = ""
    capabilities: list[str] = Field(default_factory=list)
    robot_photo: str = ""
    notes: str = ""


pit_router = APIRouter(prefix="/api/pit", tags=["pit"])


@pit_router.post("")
def submit_pit(
    body: PitIn,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    event_key = (body.event_key or get_setting(session, "current_event")).strip()
    existing = session.exec(
        select(PitEntry).where(
            PitEntry.event_key == event_key,
            PitEntry.team_number == body.team_number,
        )
    ).first()
    data = body.model_dump()
    data["event_key"] = event_key
    if existing:
        for k, v in data.items():
            setattr(existing, k, v)
        existing.scout_id = scouter.scout_id
        row = existing
    else:
        row = PitEntry(**data, scout_id=scouter.scout_id)
    session.add(row)
    session.commit()
    emit("pit_submitted", {"team": body.team_number})
    return {"ok": True}


@pit_router.get("/{team_number}")
def get_pit(
    team_number: int,
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> dict | None:
    event_key = (event or get_setting(session, "current_event")).strip()
    row = session.exec(
        select(PitEntry).where(
            PitEntry.event_key == event_key,
            PitEntry.team_number == team_number,
        )
    ).first()
    if not row:
        return None
    return {
        "team_number": row.team_number,
        "drivetrain": row.drivetrain,
        "weight_lbs": row.weight_lbs,
        "width_in": row.width_in,
        "length_in": row.length_in,
        "can_climb": row.can_climb,
        "auto_routine": row.auto_routine,
        "capabilities": row.capabilities,
        "robot_photo": row.robot_photo,
        "notes": row.notes,
    }
