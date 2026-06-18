"""Team profiles, avatars, robot photos, EPA."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..auth import current_scouter
from ..database import get_session
from ..external import sync_team
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


@router.get("/{team_number}")
async def get_team(
    team_number: int,
    refresh: bool = False,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> dict:
    tc = session.get(TeamCache, team_number)
    if refresh or tc is None:
        tc = await sync_team(session, team_number)
    return _team_dict(tc)


@router.post("/batch")
async def get_teams_batch(
    body: dict,
    refresh: bool = False,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """Resolve several teams at once (used by the pre-match screen)."""
    out = []
    for n in body.get("teams", [])[:24]:
        try:
            n = int(n)
        except (TypeError, ValueError):
            continue
        tc = session.get(TeamCache, n)
        if refresh:
            tc = await sync_team(session, n)
        out.append(_team_dict(tc, n))
    return out
