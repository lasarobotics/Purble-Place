"""Team profiles, avatars, robot photos, EPA."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import repo
from ..analytics import team_entries, team_heatmap, team_summary
from ..auth import current_scouter
from ..external import sync_team
from ..insights import team_insight
from ..models import Scouter, TeamCache

router = APIRouter(prefix="/api/teams", tags=["teams"])


def _team_dict(tc: TeamCache | None, team_number: int | None = None) -> dict:
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


def report_dict(entry, scout_name: str) -> dict:
    """The per-match report shape shared by the team and admin screens."""
    return {
        "id": entry.id,
        "match_number": entry.match_number,
        "comp_level": entry.comp_level,
        "alliance": entry.alliance,
        "station": entry.station,
        "scout_id": entry.scout_id,
        "scout_name": scout_name,
        "points": entry.points,
        "auto_leave": entry.auto_leave,
        "auto_climb": entry.auto_climb,
        "climb": entry.climb,
        "climb_seconds": entry.climb_seconds,
        "tags": entry.tags or [],
        "played_defense": entry.played_defense,
        "defense_rating": entry.defense_rating,
        "defense_on": entry.defense_on,
        "successful_stops": entry.successful_stops,
        "driver_skill": entry.driver_skill,
        "speed_rating": entry.speed_rating,
        "fouls": entry.fouls,
        "failure": entry.failure,
        "failure_details": entry.failure_details,
        "no_show": entry.no_show,
        "notes": entry.notes,
        "created_at": entry.created_at.isoformat(),
    }


def scout_name(scout_id: str) -> str:
    s = repo.scouter(scout_id)
    return (s.display_name or s.scout_id) if s else scout_id


@router.get("/{team_number}/scouting")
def get_team_scouting(
    team_number: int,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(event)
    reports = [
        report_dict(e, scout_name(e.scout_id))
        for e in sorted(team_entries(event_key, team_number), key=lambda e: ({"qm": 0, "ef": 1, "qf": 2, "sf": 3, "f": 4}.get(e.comp_level, 0), e.match_number, e.created_at), reverse=True)
    ]
    return {
        "summary": team_summary(event_key, team_number),
        "heatmap": team_heatmap(event_key, team_number),
        "reports": reports,
    }


@router.get("/{team_number}/insight")
def get_team_insight(
    team_number: int,
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """Haze Intel: an AI-assisted summary where every claim carries the
    scouting evidence behind it."""
    event_key = repo.resolve_event(event)
    return team_insight(event_key, team_number)


@router.get("/{team_number}")
async def get_team(
    team_number: int,
    refresh: bool = False,
    _: Scouter = Depends(current_scouter),
) -> dict:
    tc = repo.team(team_number)
    if refresh or tc is None:
        tc = await sync_team(team_number)
    return _team_dict(tc)


@router.post("/batch")
async def get_teams_batch(
    body: dict,
    refresh: bool = False,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """Resolve several teams at once (used by the pre-match screen)."""
    out = []
    for n in body.get("teams", [])[:24]:
        try:
            n = int(n)
        except (TypeError, ValueError):
            continue
        tc = repo.team(n)
        if refresh:
            tc = await sync_team(n)
        out.append(_team_dict(tc, n))
    return out
