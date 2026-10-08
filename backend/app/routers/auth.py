"""Sign-in + identity."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import (
    create_token,
    current_scouter,
    get_account,
    verify_login_password,
)
from .. import repo
from ..config import settings
from .. import seasons
from ..models import Scouter

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    scout_id: str
    team_password: str


class LoginOut(BaseModel):
    token: str
    scout_id: str
    role: str
    is_admin: bool
    picklist_only: bool
    display_name: str
    bucks: int


def _scouter_out(s: Scouter, token: str) -> LoginOut:
    return LoginOut(
        token=token,
        scout_id=s.scout_id,
        role=s.role,
        is_admin=s.is_admin,
        picklist_only=s.picklist_only,
        display_name=s.display_name or s.scout_id,
        bucks=s.bucks,
    )


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn) -> LoginOut:
    scout_id = body.scout_id.strip()
    if not scout_id:
        raise HTTPException(status_code=400, detail="Scouter ID required")
    if not verify_login_password(scout_id, body.team_password):
        raise HTTPException(status_code=401, detail="Incorrect team password")
    # Refuses anything that is not on the team's roster (403).
    scouter = get_account(scout_id)
    token = create_token(scouter.scout_id, scouter.is_admin)
    return _scouter_out(scouter, token)


@router.get("/me", response_model=LoginOut)
def me(scouter: Scouter = Depends(current_scouter)) -> LoginOut:
    token = create_token(scouter.scout_id, scouter.is_admin)
    return _scouter_out(scouter, token)


@router.get("/config")
def public_config() -> dict:
    return {
        "app_name": settings.APP_NAME,
        "brand_color": settings.BRAND_COLOR,
        "season": settings.SEASON,
        "environment": settings.ENVIRONMENT,
        "home_teams": settings.HOME_TEAMS,
    }


# The season definition is public and unauthenticated on purpose: the scouting
# form needs it to render, and a device that has gone offline mid-event should
# be able to fetch and cache it without a round trip through sign-in.
game_router = APIRouter(prefix="/api/game", tags=["game"])


@game_router.get("")
def game_definition(season: str | None = None) -> dict:
    """The game a season is running: phases, pieces, locations, actions,
    scoring rules, endgame states and tags.

    Public and unauthenticated on purpose: a scouting device that has gone
    offline mid-event needs this to render its form, and should be able to
    fetch and cache it without a round trip through sign-in.
    """
    season_id = seasons.resolve(season)
    definition = seasons.definition(season_id).to_dict()
    row = repo.season(season_id) if season_id else None
    return {
        **definition,
        "season_id": season_id,
        "game_version": row.game_version if row else 0,
        # Kept under the old name so a device holding a cached copy from
        # before seasons existed still finds the year where it expects it.
        "season": definition.get("year", 0),
    }
