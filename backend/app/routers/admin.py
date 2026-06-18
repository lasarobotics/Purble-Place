"""Admin: event/match control, betting management, analytics."""
from __future__ import annotations

import re
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, delete, select

from ..analytics import (
    RANK_METRICS,
    compare_teams,
    data_picklist,
    event_teams,
    rank_teams,
    team_entries,
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


def _youtube_id(value: str) -> str:
    value = (value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return value
    match = re.search(r"(?:v=|/embed/|youtu\.be/|/v/|/shorts/)([A-Za-z0-9_-]{11})", value)
    return match.group(1) if match else value


def _settle_finished_matches(session: Session, event_key: str) -> int:
    settled = 0
    for match in session.exec(select(MatchRecord).where(MatchRecord.event_key == event_key)).all():
        if match.winner is not None:
            settled += resolve_match_bets(session, match)
    return settled


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
    settled = _settle_finished_matches(session, event_key) if event_key else 0
    emit("settings_changed", {"current_event": event_key})
    return {"ok": True, "event": event_key, "matches": len(matches), "bets_settled": settled}


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
        settled = _settle_finished_matches(session, event_key)
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
    emit("settings_changed", {"betting_enabled": body.enabled})
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


def _admin_bet_dict(session: Session, bet: Bet) -> dict:
    scouter = session.get(Scouter, bet.scout_id)
    return {
        "id": bet.id,
        "scout_id": bet.scout_id,
        "scout_name": scouter.display_name if scouter else bet.scout_id,
        "match_key": bet.match_key,
        "match_number": bet.match_number,
        "comp_level": bet.comp_level,
        "pick": bet.pick,
        "wager": bet.wager,
        "win_prob": bet.win_prob,
        "multiplier": bet.multiplier,
        "potential_payout": bet.potential_payout,
        "status": bet.status,
        "payout": bet.payout,
        "created_at": bet.created_at.isoformat(),
    }


@router.get("/bets")
def list_bets(
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> list[dict]:
    rows = session.exec(select(Bet).order_by(Bet.id.desc())).all()
    return [_admin_bet_dict(session, bet) for bet in rows]


@router.delete("/bets/{bet_id}")
def delete_bet(
    bet_id: int,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    bet = session.get(Bet, bet_id)
    if not bet:
        raise HTTPException(status_code=404, detail="Bet not found")
    scouter = session.get(Scouter, bet.scout_id)
    if scouter:
        if bet.status in ("open", "lost"):
            scouter.bucks += bet.wager
        elif bet.status == "won":
            scouter.bucks -= max(0, bet.payout - bet.wager)
        session.add(scouter)
    session.delete(bet)
    session.commit()
    emit("bet_deleted", {"id": bet_id})
    return {"ok": True, "bucks": scouter.bucks if scouter else None}


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
    m.youtube_key = _youtube_id(body.youtube_key)
    if body.film_summary is not None:
        m.film_summary = body.film_summary
    if body.film_events is not None:
        m.film_events = body.film_events
    session.add(m)
    session.commit()
    emit("film_updated", {"match_key": body.match_key})
    return {"ok": True}


@router.post("/match/result")
def set_result(
    _: Scouter = Depends(require_admin),
) -> dict:
    raise HTTPException(status_code=400, detail="Manual result setting is disabled. Winners are pulled from TBA.")


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
async def rank(
    metric: str = "avg_points",
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(session, "current_event")).strip()
    return {"metric": metric, "teams": rank_teams(session, event_key, metric)}


@router.get("/data-picklist")
async def get_data_picklist(
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(session, "current_event")).strip()
    return data_picklist(session, event_key)


@router.get("/compare")
async def compare(
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
    nums = nums[:6]
    return compare_teams(session, event_key, nums)


@router.get("/team/{team}/summary")
async def get_team_summary(
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


@router.get("/team/{team}/reports")
def get_team_reports(
    team: int,
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> list[dict]:
    event_key = (event or get_setting(session, "current_event")).strip()
    rows = team_entries(session, event_key, team)
    out = []
    for entry in rows:
        scouter = session.get(Scouter, entry.scout_id)
        out.append(
            {
                "id": entry.id,
                "match_number": entry.match_number,
                "comp_level": entry.comp_level,
                "alliance": entry.alliance,
                "station": entry.station,
                "scout_id": entry.scout_id,
                "scout_name": scouter.display_name if scouter else entry.scout_id,
                "points": entry.points,
                "auto_leave": entry.auto_leave,
                "auto_climb": entry.auto_climb,
                "climb": entry.climb,
                "climb_seconds": entry.climb_seconds,
                "played_defense": entry.played_defense,
                "defense_rating": entry.defense_rating,
                "defense_on": entry.defense_on,
                "successful_stops": entry.successful_stops,
                "driver_skill": entry.driver_skill,
                "speed_rating": entry.speed_rating,
                "fouls": entry.fouls,
                "failure": entry.failure,
                "failure_details": entry.failure_details,
                "notes": entry.notes,
                "created_at": entry.created_at.isoformat(),
            }
        )
    return out


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
