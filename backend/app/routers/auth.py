"""Sign-in + identity."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from threading import Lock
import time

from ..auth import (
    create_token,
    current_scouter,
    get_account,
    verify_login_password,
    canonical_account_id,
    hash_password,
)
from .. import repo
from ..config import settings
from .. import seasons
from ..models import Scouter

router = APIRouter(prefix="/api/auth", tags=["auth"])
_setup_lock = Lock()


def _session_cookie(response: Response, request: Request, token: str) -> None:
    secure = request.url.scheme == "https"
    origin = request.headers.get("origin", "")
    cross_origin = origin and origin.rstrip("/") != str(request.base_url).rstrip("/")
    response.set_cookie("hazehub_session", token, httponly=True, secure=secure,
                        samesite="none" if secure and cross_origin else "lax",
                        path="/api/auth", max_age=settings.TOKEN_TTL_HOURS * 3600)
    response.headers["Cache-Control"] = "no-store"


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
    s_number: int = 0
    name_confirmed: bool = False


def _scouter_out(s: Scouter, token: str) -> LoginOut:
    return LoginOut(
        token=token,
        scout_id=s.scout_id,
        role=s.role,
        is_admin=s.is_admin,
        picklist_only=s.picklist_only,
        display_name=s.display_name or s.scout_id,
        bucks=s.bucks,
        s_number=s.s_number,
        name_confirmed=s.name_confirmed,
    )


class AccountIn(BaseModel):
    scout_id: str


class SetupIn(AccountIn):
    password: str
    password_confirmation: str


def _roster_account(scout_id: str) -> Scouter:
    canonical = canonical_account_id(scout_id)
    account = repo.scouter(canonical) if canonical else None
    if account is None or not account.active or account.deleted:
        raise HTTPException(status_code=403, detail="This ID is not on the account roster. Ask an admin for help.")
    return account


@router.post("/account-status")
def account_status(body: AccountIn) -> dict:
    account = _roster_account(body.scout_id)
    return {"needs_setup": account.scout_id != "Admin" and not account.password_hash}


@router.post("/setup", response_model=LoginOut)
def setup(body: SetupIn, response: Response, request: Request) -> LoginOut:
    if not 8 <= len(body.password) <= 128:
        raise HTTPException(status_code=400, detail="Use a password between 8 and 128 characters.")
    if body.password != body.password_confirmation:
        raise HTTPException(status_code=400, detail="Passwords do not match.")
    # The service uses one authoritative process. Serialize first-time claims
    # so two requests cannot replace each other's initial password.
    with _setup_lock:
        account = _roster_account(body.scout_id)
        if account.scout_id == "Admin" or account.password_hash:
            raise HTTPException(status_code=409, detail="This account is already set up. Sign in instead.")
        account.password_hash = hash_password(body.password)
        if account.scout_id == "Admin":
            account.role = "admin"
        repo.save_scouter(account)
    token = create_token(account.scout_id, account.is_admin)
    _session_cookie(response, request, token)
    return _scouter_out(account, token)


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, response: Response, request: Request) -> LoginOut:
    scout_id = body.scout_id.strip()
    if not scout_id:
        raise HTTPException(status_code=400, detail="Scouter ID required")
    if not verify_login_password(scout_id, body.team_password):
        raise HTTPException(status_code=401, detail="Incorrect ID or password")
    # Refuses anything that is not on the team's roster (403).
    scouter = get_account(scout_id)
    token = create_token(scouter.scout_id, scouter.is_admin)
    _session_cookie(response, request, token)
    return _scouter_out(scouter, token)


@router.get("/me", response_model=LoginOut)
def me(scouter: Scouter = Depends(current_scouter)) -> LoginOut:
    token = create_token(scouter.scout_id, scouter.is_admin)
    return _scouter_out(scouter, token)


@router.post("/logout")
def logout(response: Response) -> dict:
    response.delete_cookie("hazehub_session", path="/api/auth")
    return {"ok": True}


@router.post("/offline-provision")
def offline_provision(body: LoginIn, scouter: Scouter = Depends(current_scouter)) -> dict:
    """Authorize only this account after fresh password proof; never export hashes."""
    if (scouter.is_admin or scouter.picklist_only or not scouter.password_hash
            or canonical_account_id(body.scout_id) != scouter.scout_id):
        raise HTTPException(status_code=403, detail="Only personal scouting accounts can prepare offline sign-in.")
    if not verify_login_password(scouter.scout_id, body.team_password):
        raise HTTPException(status_code=401, detail="Sign in with your current password to prepare this device.")
    return {"version": 1, "scout_id": scouter.scout_id, "s_number": scouter.s_number,
            "display_name": scouter.display_name or scouter.scout_id,
            "issued_at": int(time.time()) * 1000, "expires_at": (int(time.time()) + 86400) * 1000}


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
