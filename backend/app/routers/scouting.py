
"""Match scouting + pit scouting.

Submissions follow the direct-to-cloud contract: the device assigns a UUID and
a SHA-256 payload hash; the server commits exactly once, returns the original
acknowledgement for identical retries, and 409s a UUID reused with a different
payload (corrections must be new records that supersede the original).

On Firestore that contract is enforced by the storage layer rather than by
application logic: the submission UUID **is** the document ID, and the write
uses ``create()``, which fails if the document already exists. A device that
replays its whole offline queue cannot produce a duplicate.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import repo, schema
from ..auth import current_scouter
from ..cache import WriteTooLarge
from ..external import sync_team
from ..models import PitEntry, Scouter, ScoutEntry
from ..realtime import emit
from ..scoring import compute_points

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
    # Omit absent/zero counters to preserve hashes from older offline clients.
    for key in ("auto_missed", "teleop_missed"):
        if data.get(key):
            subset[key] = data[key]
    canonical = json.dumps(subset, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate_submission(data: dict[str, Any]) -> str | None:
    """Field validation shared by the single and batch paths.

    Returns an error string (or None). Kept out of the Pydantic model on
    purpose: one invalid record in a batch must fail individually, not 422 the
    whole request.

    The size bounds are Firestore's, pulled forward: a document is capped at
    1 MiB and at 40,000 index entries, so an absurd heatmap is rejected here
    with a clear message instead of failing mid-commit.
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
    if len(str(data.get("notes") or "")) > schema.MAX_NOTES_CHARS:
        return f"notes over maximum length ({schema.MAX_NOTES_CHARS})"
    if len(data.get("heatmap") or []) > schema.MAX_HEATMAP_ATTEMPTS:
        return f"heatmap over maximum length ({schema.MAX_HEATMAP_ATTEMPTS} attempts)"
    if len(data.get("tags") or []) > schema.MAX_TAGS:
        return f"too many tags (max {schema.MAX_TAGS})"
    return None


class ScoutIn(BaseModel):
    season_id: str = ""
    game_version: int = 0
    form_id: str = ""
    form_version: int = 0
    responses: dict[str, Any] = Field(default_factory=dict)
    actions: list[dict[str, Any]] = Field(default_factory=list)
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
    auto_missed: int = Field(default=0, ge=0, le=999)
    teleop_missed: int = Field(default=0, ge=0, le=999)

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
        "client_uuid": e.client_uuid or e.submission_id,
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
        "auto_missed": e.data.get("auto_missed", 0),
        "teleop_missed": e.data.get("teleop_missed", 0),
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
        # Firestore, so its status is always "synced" from the server's view;
        # the device's own queue tracks anything not yet committed here.
        "submission_id": e.submission_id,
        "client_ts": e.client_ts.isoformat() if e.client_ts else None,
        "azure_received_at": e.azure_received_at.isoformat() if e.azure_received_at else None,
        "payload_hash": e.payload_hash,
        "schema_version": e.schema_version,
        "supersedes_submission_id": e.supersedes_submission_id,
        "cloud_status": e.cloud_status,
    }


def lock_betting_for_match(event_key: str, comp_level: str, match_number: int) -> bool:
    """First scouting report on a match closes its betting window.

    Returns whether a match record was found. ``repo.save_match`` skips the
    Firestore write when the flag was already set, so the second through
    twelfth reports on the same match cost nothing.
    """
    match = repo.match_by_number(event_key, comp_level, match_number)
    if match is None:
        return False
    if not match.betting_locked:
        match.betting_locked = True
        repo.save_match(match)
    return True


@router.post("")
async def submit_scout(
    body: ScoutIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(body.event_key)

    error = validate_submission(body.model_dump())
    if error:
        raise HTTPException(status_code=422, detail=error)

    # Direct-to-cloud idempotency (PUT semantics on the submission UUID):
    #   same UUID + same payload hash      → return the original acknowledgement
    #   same UUID + different payload hash → 409, never overwrite
    key = body.submission_id or body.client_uuid
    if key:
        existing = repo.scouting_by_submission(key)
        if existing:
            if (
                body.payload_hash
                and existing.payload_hash
                and body.payload_hash != existing.payload_hash
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Submission UUID exists with a different payload: "
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

    try:
        created = repo.create_scouting(entry)
    except WriteTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    if not created:
        # Lost a race with a concurrent retry of the same UUID.
        stored = repo.scouting_by_submission(entry.submission_id)
        if stored:
            return {"ok": True, "duplicate": True, "entry": _entry_dict(stored)}

    # Counter bumps are coalesced: a scout submitting six reports in a minute
    # costs one scouters write, not six.
    scouter.matches_scouted += 1
    repo.save_scouter(scouter, coalesce=True)

    matched = lock_betting_for_match(event_key, body.comp_level, body.match_number)

    # Warm the team cache the first time we see a team (best effort).
    if repo.team(body.team_number) is None:
        try:
            await sync_team(body.team_number)
        except Exception:  # noqa: BLE001
            pass

    # Acknowledgement: the record is committed to Firestore: the device can
    # mark it "acknowledged"; every dashboard refetches.
    emit("submission_ack", {
        "submission_id": entry.submission_id,
        "id": entry.id,
        "azure_received_at": entry.azure_received_at.isoformat(),
    })
    emit("scout_submitted", {
        "team": entry.team_number,
        "match": entry.match_number,
        "bets_locked": matched,
    })
    return {"ok": True, "duplicate": False, "entry": _entry_dict(entry)}


@router.get("/mine")
def my_entries(scouter: Scouter = Depends(current_scouter)) -> list[dict]:
    return [_entry_dict(e) for e in repo.scouting_for_scout(scouter.scout_id)]


@router.get("/last-assignment")
def last_assignment(scouter: Scouter = Depends(current_scouter)) -> dict:
    """Remember the scouter's last alliance + station so the next match
    auto-fills the same slot (they can still change it)."""
    rows = repo.scouting_for_scout(scouter.scout_id)
    if not rows:
        return {"alliance": "red", "station": 1}
    last = rows[0]
    return {"alliance": last.alliance, "station": last.station}


@router.get("/last-data-entry")
def last_data_entry(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(event)
    latest = max(
        (e.created_at for e in repo.scouting_for_event(event_key)),
        default=None,
    )
    return {
        "event": event_key,
        "last_data_entry": latest.isoformat() if latest else None,
    }


@router.get("/match/{match_number}")
def entries_for_match(
    match_number: int,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    event_key = repo.resolve_event(event)
    return [_entry_dict(e) for e in repo.scouting_for_match(event_key, match_number)]


@router.get("/team/{team_number}")
def entries_for_team(
    team_number: int,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """Every report on one robot this event, in match order.

    Backs the ``@all:field`` reference in a picklist justification, which
    pulls one measurement across the whole event rather than one match. Same
    shape as ``/match/{n}`` so the reader renders both the same way.
    """
    event_key = repo.resolve_event(event)
    rows = sorted(
        repo.scouting_for_team(event_key, team_number),
        key=lambda e: (e.match_number, e.id or 0),
    )
    return [_entry_dict(e) for e in rows]


# --------------------------------------------------------------------------- #
# Pit scouting                                                                 #
# --------------------------------------------------------------------------- #
class PitIn(BaseModel):
    """A pit report.

    Two ways in. The named fields are the ones the analytics and the team
    detail popup read. ``answers`` is what the pit form actually collected,
    keyed by field key: anything whose key matches a named field is folded
    into it, and everything else is kept in ``responses`` so a form built for
    a new game does not need a schema change to store its questions.
    """

    event_key: Optional[str] = None
    team_number: int = Field(gt=0)
    drivetrain: str = ""
    archetype: str = ""
    weight_lbs: Optional[float] = Field(default=None, ge=0, le=1000)
    width_in: Optional[float] = Field(default=None, ge=0, le=500)
    length_in: Optional[float] = Field(default=None, ge=0, le=500)
    can_climb: str = "none"
    auto_routine: str = ""
    capabilities: list[str] = Field(default_factory=list, max_length=100)
    robot_photo: str = ""
    robot_photos: list[str] = Field(default_factory=list)
    notes: str = Field(default="", max_length=schema.MAX_NOTES_CHARS)
    answers: dict[str, Any] = Field(default_factory=dict)
    form_id: str = Field(default="", max_length=100)
    form_version: int = Field(default=0, ge=0)
    season_id: str = Field(default="", max_length=100)


#: PitEntry columns that a form field may fill in by using the same key.
PIT_COLUMNS = {
    "drivetrain", "archetype", "weight_lbs", "width_in", "length_in",
    "can_climb", "auto_routine", "capabilities", "robot_photo", "notes",
}


pit_router = APIRouter(prefix="/api/pit", tags=["pit"])


@pit_router.post("")
def submit_pit(
    body: PitIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(body.event_key)
    scheduled = {
        team
        for match in repo.matches_for_event(event_key)
        for team in (*match.red, *match.blue)
    }
    if not scheduled:
        raise HTTPException(
            status_code=409,
            detail="Load this event's schedule before pit scouting so team numbers can be verified.",
        )
    if body.team_number not in scheduled:
        raise HTTPException(
            status_code=400,
            detail=f"Team {body.team_number} is not on the schedule for {event_key}.",
        )
    row = repo.pit(event_key, body.team_number) or PitEntry(
        event_key=event_key, team_number=body.team_number
    )
    data = body.model_dump()
    data.pop("event_key", None)
    answers = data.pop("answers", None) or {}
    photos = list(data.pop("robot_photos", None) or [])
    form_version = data.pop("form_version", 0)

    for k, v in data.items():
        setattr(row, k, v)

    # Split what the form collected: known keys fill their column so the
    # existing screens keep working, the rest is kept verbatim.
    extra = {}
    for key, value in answers.items():
        if key in PIT_COLUMNS:
            setattr(row, key, value)
        elif key != "team_number":
            extra[key] = value
    if answers:
        row.responses = extra
        row.form_version = int(form_version or 0)

    row.event_key = event_key
    row.scout_id = scouter.scout_id
    try:
        answer_photos = answers.pop("robot_photo", None)
        if isinstance(answer_photos, list):
            photos = answer_photos
        elif isinstance(answer_photos, str) and answer_photos:
            photos = [answer_photos]
        elif row.robot_photo and not photos:
            photos = [row.robot_photo]
        repo.save_pit_with_photos(row, photos)
    except (WriteTooLarge, ValueError) as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    emit("pit_submitted", {"team": body.team_number})
    return {"ok": True}


def _pit_dict(row, include_photos: bool = True) -> dict:
    return {
        "event_key": row.event_key,
        "team_number": row.team_number,
        "drivetrain": row.drivetrain,
        "archetype": row.archetype,
        "weight_lbs": row.weight_lbs,
        "width_in": row.width_in,
        "length_in": row.length_in,
        "can_climb": row.can_climb,
        "auto_routine": row.auto_routine,
        "capabilities": row.capabilities,
        "robot_photo": row.robot_photo,
        "robot_photos": repo.pit_photo_images(row) if include_photos else [],
        "photo_count": len(row.photo_ids) + (1 if row.robot_photo else 0),
        "notes": row.notes,
        "responses": row.responses,
        "form_id": row.form_id,
        "form_version": row.form_version,
        "season_id": row.season_id,
        "scout_id": row.scout_id,
        "updated_at": row.updated_at.isoformat(),
    }


@pit_router.get("")
def list_pit(
    event: str | None = None,
    photos: bool = False,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """Every pit report at this event.

    Photos are base64 blobs measured in hundreds of KiB, so the list omits
    them unless asked; the page that shows one fetches that team on its own.
    """
    event_key = repo.resolve_event(event)
    out = []
    for row in repo.pits_for_event(event_key):
        data = _pit_dict(row, include_photos=photos)
        if not photos:
            data["robot_photo"] = ""
            data["robot_photos"] = []
            data["has_photo"] = bool(row.robot_photo or row.photo_ids)
        else:
            data["has_photo"] = bool(data["robot_photos"])
        out.append(data)
    return out


@pit_router.get("/{team_number}")
def get_pit(
    team_number: int,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict | None:
    event_key = repo.resolve_event(event)
    row = repo.pit(event_key, team_number)
    if not row:
        return None
    return _pit_dict(row)


@pit_router.get("/verify/team/{team_number}")
def check_pit_team(
    team_number: int,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    if team_number < 1:
        raise HTTPException(status_code=400, detail="Team number must be at least 1")
    event_key = repo.resolve_event(event)
    scheduled = {
        team
        for match in repo.matches_for_event(event_key)
        for team in (*match.red, *match.blue)
    }
    return {
        "event": event_key,
        "team_number": team_number,
        "valid": team_number in scheduled,
        "schedule_loaded": bool(scheduled),
    }
