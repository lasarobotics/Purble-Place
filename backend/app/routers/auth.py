"""Sign-in + identity."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from pymongo.database import Database

from ..auth import (
    create_token,
    current_scouter,
    get_or_create_scouter,
    verify_team_password,
)
from ..config import settings
from ..database import database_dependency
from ..views import ScouterView

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    scout_id: str
    team_password: str


class LoginOut(BaseModel):
    token: str
    scout_id: str
    is_admin: bool
    display_name: str
    bucks: int


def _scouter_out(s: ScouterView, token: str) -> LoginOut:
    return LoginOut(
        token=token,
        scout_id=s.scout_id,
        is_admin=s.is_admin,
        display_name=s.display_name or s.scout_id,
        bucks=s.bucks,
    )


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, db: Database = Depends(database_dependency)) -> LoginOut:
    scout_id = body.scout_id.strip()
    if not scout_id:
        raise HTTPException(status_code=400, detail="Scouter ID required")
    if not verify_team_password(body.team_password):
        raise HTTPException(status_code=401, detail="Incorrect team password")
    scouter = get_or_create_scouter(db, scout_id)
    token = create_token(scouter.scout_id, scouter.is_admin)
    return _scouter_out(scouter, token)


@router.get("/me", response_model=LoginOut)
def me(scouter: ScouterView = Depends(current_scouter)) -> LoginOut:
    token = create_token(scouter.scout_id, scouter.is_admin)
    return _scouter_out(scouter, token)


@router.get("/config")
def public_config() -> dict:
    return {
        "app_name": settings.app_name,
        "brand_color": settings.brand_color,
        "season": settings.season,
        "home_teams": list(settings.home_teams),
    }
