"""Team profiles, avatars, robot photos, EPA."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pymongo.database import Database

from ..analytics import team_entries, team_heatmap, team_summary
from ..auth import current_scouter
from ..database import database_dependency
from ..external import sync_team
from ..insights import team_insight
from ..store import get_setting
from ..views import ScouterView, get_team_cache, scouter_names

router = APIRouter(prefix="/api/teams", tags=["teams"])


def _team_dict(tc: Any, team_number: int | None = None) -> dict:
    if tc is None:
        n = int(team_number or 0)
        return {
            "team_number": n,
            "nickname": "",
            "name": "",
            "city": "",
            "state": "",
            "country": "",
            "rookie_year": None,
            "avatar": "",
            "photos": [],
            "epa": None,
        }
    return {
        "team_number": tc.team_number,
        "nickname": tc.nickname,
        "name": tc.name,
        "city": tc.city,
        "state": tc.state,
        "country": tc.country,
        "rookie_year": tc.rookie_year,
        "avatar": tc.avatar,
        "photos": tc.photos,
        "epa": tc.epa,
    }


def entry_report(e, scout_name: str) -> dict:
    return {
        "id": e.id,
        "match_number": e.match_number,
        "comp_level": e.comp_level,
        "alliance": e.alliance,
        "station": e.station,
        "scout_id": e.scout_id,
        "scout_name": scout_name,
        "points": e.points,
        "auto_leave": e.auto_leave,
        "auto_climb": e.auto_climb,
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
        "created_at": e.created_at.isoformat(),
    }


@router.get("/{team_number}/scouting")
def get_team_scouting(
    team_number: int,
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict:
    event_key = (event or get_setting(db, "current_event")).strip()
    entries = team_entries(db, event_key, team_number)
    names = scouter_names(db, (e.scout_id for e in entries))
    reports = [entry_report(e, names.get(e.scout_id, e.scout_id)) for e in entries]
    return {
        "summary": team_summary(db, event_key, team_number, entries),
        "heatmap": team_heatmap(db, event_key, team_number, entries=entries),
        "heatmaps": {phase: team_heatmap(db, event_key, team_number, None if phase == "all" else phase, entries) for phase in ("all", "auto", "teleop")},
        "reports": reports,
    }


@router.get("/{team_number}/insight")
def get_team_insight(
    team_number: int,
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict:
    """Haze Intel — an AI-assisted summary where every claim carries the
    scouting evidence behind it."""
    event_key = (event or get_setting(db, "current_event")).strip()
    return team_insight(db, event_key, team_number)


@router.get("/{team_number}")
def get_team(
    team_number: int,
    refresh: bool = False,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict:
    tc = get_team_cache(db, team_number)
    if refresh or tc is None:
        tc = sync_team(db, team_number) or tc
    return _team_dict(tc, team_number)


@router.post("/batch")
def get_teams_batch(
    body: dict,
    refresh: bool = False,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> list[dict]:
    """Resolve several teams at once (used by the pre-match screen)."""
    out = []
    for n in body.get("teams", [])[:24]:
        try:
            n = int(n)
        except (TypeError, ValueError):
            continue
        tc = get_team_cache(db, n)
        if refresh:
            tc = sync_team(db, n) or tc
        out.append(_team_dict(tc, n))
    return out
