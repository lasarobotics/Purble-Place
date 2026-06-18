"""Match scouting + pit scouting."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends
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

    played_defense: bool = False
    defense_rating: int = 0
    defense_on: str = ""
    successful_stops: int = 0
    driver_skill: int = 3
    speed_rating: int = 3
    fouls: int = 0
    failure: bool = False
    failure_details: str = ""
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
        "played_defense": e.played_defense,
        "defense_rating": e.defense_rating,
        "defense_on": e.defense_on,
        "successful_stops": e.successful_stops,
        "driver_skill": e.driver_skill,
        "speed_rating": e.speed_rating,
        "fouls": e.fouls,
        "failure": e.failure,
        "failure_details": e.failure_details,
        "notes": e.notes,
        "points": e.points,
        "created_at": e.created_at.isoformat(),
    }


@router.post("")
async def submit_scout(
    body: ScoutIn,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    event_key = (body.event_key or get_setting(session, "current_event")).strip()

    # Idempotency: re-syncing the same offline entry must not duplicate.
    if body.client_uuid:
        existing = session.exec(
            select(ScoutEntry).where(ScoutEntry.client_uuid == body.client_uuid)
        ).first()
        if existing:
            return {"ok": True, "duplicate": True, "entry": _entry_dict(existing)}

    data = body.model_dump()
    data["event_key"] = event_key
    data["scout_id"] = scouter.scout_id
    points = compute_points(data)

    entry = ScoutEntry(**{**data, "points": points})
    session.add(entry)

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

    session.commit()
    session.refresh(entry)

    # Warm the team cache the first time we see a team (best effort).
    if session.get(TeamCache, body.team_number) is None:
        try:
            await sync_team(session, body.team_number)
        except Exception:
            pass

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
