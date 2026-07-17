"""Match scouting + pit scouting."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from pymongo.database import Database

from ..auth import current_scouter
from ..database import database_dependency
from ..external import sync_team
from ..models import MatchScoutingDocument, PitScoutingDocument, ScoutingData
from ..realtime import emit
from ..repositories import ConflictError, HazeHubRepository, ReferenceNotFoundError
from ..scoring import compute_points
from ..store import get_setting
from ..views import EntryView, ScouterView, list_entries

router = APIRouter(prefix="/api/scout", tags=["scouting"])

PAYLOAD_KEYS = (
    "heatmap", "auto_leave", "auto_climb", "climb", "climb_seconds",
    "tags", "played_defense", "defense_rating", "defense_on",
    "successful_stops", "driver_skill", "speed_rating",
    "failure", "failure_details",
)


class ScoutIn(BaseModel):
    client_uuid: Optional[str] = None
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


def entry_dict(e: EntryView) -> dict:
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
    }


def build_document(body: ScoutIn, event_key: str, scout_id: str) -> MatchScoutingDocument:
    submission = body.model_dump()
    payload = {k: submission[k] for k in PAYLOAD_KEYS}
    payload["foul_count"] = int(body.fouls or 0)
    points = 0.0 if body.no_show else compute_points(
        {**submission, "foul_count": payload["foul_count"]}
    )
    return MatchScoutingDocument(
        client_submission_id=body.client_uuid or None,
        event_key=event_key,
        comp_level=body.comp_level,
        match_num=int(body.match_number),
        team_num=int(body.team_number),
        alliance=body.alliance,
        station=max(1, min(3, int(body.station or 1))),
        scouter_id=scout_id,
        data=ScoutingData(**payload),
        points=points,
        no_show=bool(body.no_show),
        comments=body.notes or None,
    )


def find_by_client_uuid(db: Database, client_uuid: str | None) -> EntryView | None:
    if not client_uuid:
        return None
    doc = db.match_scouting.find_one({"client_submission_id": client_uuid})
    return EntryView(doc) if doc else None


@router.post("")
def submit_scout(
    body: ScoutIn,
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    event_key = (body.event_key or get_setting(db, "current_event")).strip()
    if not event_key:
        raise HTTPException(status_code=400, detail="No event configured yet")

    # Idempotency: re-syncing the same offline entry must not duplicate.
    existing = find_by_client_uuid(db, body.client_uuid)
    if existing:
        return {"ok": True, "duplicate": True, "entry": entry_dict(existing)}

    try:
        document = build_document(body, event_key, scouter.scout_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    repo = HazeHubRepository(db)
    try:
        stored = repo.submit_match_scouting(document)
    except ReferenceNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ConflictError as exc:
        # Unique-key clash: either the same offline entry raced in, or this
        # scouter already covered this robot in this match.
        existing = find_by_client_uuid(db, body.client_uuid)
        if existing:
            return {"ok": True, "duplicate": True, "entry": entry_dict(existing)}
        raise HTTPException(
            status_code=409,
            detail="You already submitted a report for this robot in this match",
        ) from exc

    db.scouters.update_one(
        {"_id": scouter.scout_id}, {"$inc": {"matches_scouted": 1}}
    )

    # First scouting report on a match closes its betting window.
    match = db.matches.find_one({"_id": document.match_key}, {"betting_locked": 1})
    if match and not match.get("betting_locked"):
        db.matches.update_one(
            {"_id": document.match_key}, {"$set": {"betting_locked": True}}
        )

    # Warm the team cache the first time we see a team (best effort).
    if db.team_cache.find_one({"_id": int(body.team_number)}, {"_id": 1}) is None:
        try:
            sync_team(db, body.team_number)
        except Exception:
            pass

    emit(
        db,
        "scout_submitted",
        {
            "team": document.team_num,
            "match": document.match_num,
            "bets_locked": bool(match),
        },
    )
    return {"ok": True, "duplicate": False, "entry": entry_dict(EntryView(stored))}


@router.get("/mine")
def my_entries(
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> list[dict]:
    rows = list_entries(db, scout_id=scouter.scout_id)
    rows.sort(key=lambda e: e.created_at, reverse=True)
    return [entry_dict(e) for e in rows]


@router.get("/last-assignment")
def last_assignment(
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    """Remember the scouter's last alliance + station so the next match
    auto-fills the same slot (they can still change it)."""
    doc = db.match_scouting.find_one(
        {"scouter_id": scouter.scout_id}, sort=[("submitted_at", -1)]
    )
    if not doc:
        return {"alliance": "red", "station": 1}
    last = EntryView(doc)
    return {"alliance": last.alliance, "station": last.station}


@router.get("/match/{match_number}")
def entries_for_match(
    match_number: int,
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> list[dict]:
    event_key = (event or get_setting(db, "current_event")).strip()
    rows = list_entries(db, event_key, match_number=match_number)
    return [entry_dict(e) for e in rows]


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
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    event_key = (body.event_key or get_setting(db, "current_event")).strip()
    if not event_key:
        raise HTTPException(status_code=400, detail="No event configured yet")
    try:
        document = PitScoutingDocument(
            event_key=event_key,
            team_num=int(body.team_number),
            scouter_id=scouter.scout_id,
            drivetrain=body.drivetrain,
            weight_lbs=body.weight_lbs,
            width_in=body.width_in,
            length_in=body.length_in,
            can_climb=body.can_climb,
            auto_routine=body.auto_routine,
            capabilities=body.capabilities,
            robot_photo=body.robot_photo,
            notes=body.notes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    HazeHubRepository(db).upsert_pit_scouting(document)
    emit(db, "pit_submitted", {"team": body.team_number})
    return {"ok": True}


@pit_router.get("/{team_number}")
def get_pit(
    team_number: int,
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict | None:
    event_key = (event or get_setting(db, "current_event")).strip()
    row = db.pit_scouting.find_one(
        {"event_key": event_key, "team_num": int(team_number)}
    )
    if not row:
        return None
    return {
        "team_number": row.get("team_num"),
        "drivetrain": row.get("drivetrain") or "",
        "weight_lbs": row.get("weight_lbs"),
        "width_in": row.get("width_in"),
        "length_in": row.get("length_in"),
        "can_climb": row.get("can_climb") or "none",
        "auto_routine": row.get("auto_routine") or "",
        "capabilities": row.get("capabilities") or [],
        "robot_photo": row.get("robot_photo") or "",
        "notes": row.get("notes") or "",
    }
