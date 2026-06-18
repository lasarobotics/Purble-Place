"""Admin: event/match control, betting management, analytics."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, delete, select

from ..analytics import (
    RANK_METRICS,
    compare_teams,
    data_picklist,
    event_teams,
    rank_teams,
    team_heatmap,
    team_summary,
)
from ..auth import require_admin
from ..config import settings
from ..database import get_session
from ..external import sync_event_matches
from ..models import Bet, MatchRecord, Scouter
from ..realtime import emit
from ..store import all_settings, get_setting, set_setting
from .betting import resolve_match_bets

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/settings")
def get_settings(
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    s = all_settings(session)
    return {
        "current_event": s.get("current_event", ""),
        "current_match": int(s.get("current_match", "0") or 0),
        "betting_enabled": s.get("betting_enabled", "1") == "1",
        "season": settings.SEASON,
        "is_azure": settings.IS_AZURE,
    }


class EventIn(BaseModel):
    event_key: str


@router.post("/event")
async def set_event(
    body: EventIn,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = body.event_key.strip()
    set_setting(session, "current_event", event_key)
    matches = await sync_event_matches(session, event_key) if event_key else []
    emit("settings_changed", {"current_event": event_key})
    return {"ok": True, "event": event_key, "matches": len(matches)}


class CurrentMatchIn(BaseModel):
    match_number: int


@router.post("/current-match")
async def set_current_match(
    body: CurrentMatchIn,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    set_setting(session, "current_match", str(body.match_number))
    # Pull fresh results and settle any matches that just finished.
    event_key = get_setting(session, "current_event")
    settled = 0
    if event_key:
        await sync_event_matches(session, event_key)
        for m in session.exec(
            select(MatchRecord).where(MatchRecord.event_key == event_key)
        ).all():
            if m.winner is not None:
                settled += resolve_match_bets(session, m)
    emit("match_advanced", {"current_match": body.match_number})
    return {"ok": True, "current_match": body.match_number, "bets_settled": settled}


class ToggleIn(BaseModel):
    enabled: bool


@router.post("/betting/toggle")
def toggle_betting(
    body: ToggleIn,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    set_setting(session, "betting_enabled", "1" if body.enabled else "0")
    emit("betting_toggled", {"enabled": body.enabled})
    return {"ok": True, "betting_enabled": body.enabled}


@router.post("/betting/reset")
def reset_betting(
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    """Wipe all bets and reset every scouter to the starting balance."""
    session.exec(delete(Bet))
    for s in session.exec(select(Scouter)).all():
        s.bucks = settings.STARTING_BUCKS
        session.add(s)
    session.commit()
    emit("betting_reset", {})
    return {"ok": True, "starting": settings.STARTING_BUCKS}


class MatchLockIn(BaseModel):
    match_key: str
    locked: bool


@router.post("/match/lock")
def lock_match(
    body: MatchLockIn,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    m = session.exec(
        select(MatchRecord).where(MatchRecord.match_key == body.match_key)
    ).first()
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    m.betting_locked = body.locked
    session.add(m)
    session.commit()
    emit("settings_changed", {"match_lock": body.match_key})
    return {"ok": True}


class FilmIn(BaseModel):
    match_key: str
    youtube_key: str = ""
    film_summary: str | None = None
    film_events: list[dict] | None = None


@router.post("/match/youtube")
def set_film(
    body: FilmIn,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    """Save the film for a match: video link, written takeaway, and the
    timestamped key-events play-by-play."""
    m = session.exec(
        select(MatchRecord).where(MatchRecord.match_key == body.match_key)
    ).first()
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    m.youtube_key = body.youtube_key.strip()
    if body.film_summary is not None:
        m.film_summary = body.film_summary
    if body.film_events is not None:
        m.film_events = body.film_events
    session.add(m)
    session.commit()
    emit("film_updated", {"match_key": body.match_key})
    return {"ok": True}


class ResultIn(BaseModel):
    match_key: str
    winner: str  # red / blue / tie
    red_score: Optional[int] = None
    blue_score: Optional[int] = None


@router.post("/match/result")
def set_result(
    body: ResultIn,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    if body.winner not in ("red", "blue", "tie"):
        raise HTTPException(status_code=400, detail="winner must be red/blue/tie")
    m = session.exec(
        select(MatchRecord).where(MatchRecord.match_key == body.match_key)
    ).first()
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    m.winner = body.winner
    if body.red_score is not None:
        m.red_score = body.red_score
    if body.blue_score is not None:
        m.blue_score = body.blue_score
    session.add(m)
    session.commit()
    settled = resolve_match_bets(session, m)
    return {"ok": True, "bets_settled": settled}


# --------------------------------------------------------------------------- #
# Analytics                                                                    #
# --------------------------------------------------------------------------- #
@router.get("/metrics")
def metrics(_: Scouter = Depends(require_admin)) -> dict:
    return {"metrics": [{"key": k, "label": v} for k, v in RANK_METRICS.items()]}


@router.get("/event-teams")
def list_event_teams(
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> list[int]:
    event_key = (event or get_setting(session, "current_event")).strip()
    return event_teams(session, event_key)


@router.get("/rank")
def rank(
    metric: str = "avg_points",
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(session, "current_event")).strip()
    return {"metric": metric, "teams": rank_teams(session, event_key, metric)}


@router.get("/data-picklist")
def get_data_picklist(
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(session, "current_event")).strip()
    return data_picklist(session, event_key)


@router.get("/compare")
def compare(
    teams: str,
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(session, "current_event")).strip()
    nums = []
    for part in teams.split(","):
        part = part.strip()
        if part.isdigit():
            nums.append(int(part))
    return compare_teams(session, event_key, nums[:6])


@router.get("/team/{team}/summary")
def get_team_summary(
    team: int,
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(session, "current_event")).strip()
    return team_summary(session, event_key, team)


@router.get("/team/{team}/heatmap")
def get_team_heatmap(
    team: int,
    phase: str | None = None,
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(session, "current_event")).strip()
    return team_heatmap(session, event_key, team, phase)


@router.get("/scouters")
def scouters(
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> list[dict]:
    rows = session.exec(select(Scouter)).all()
    out = []
    for s in rows:
        out.append(
            {
                "scout_id": s.scout_id,
                "display_name": s.display_name or s.scout_id,
                "is_admin": s.is_admin,
                "bucks": s.bucks,
                "matches_scouted": s.matches_scouted,
                "last_seen": s.last_seen.isoformat(),
            }
        )
    out.sort(key=lambda r: -r["matches_scouted"])
    return out
