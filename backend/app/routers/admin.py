"""Admin: event/match control, betting management, analytics."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from pymongo.database import Database

from ..analytics import (
    RANK_METRICS,
    analysis_bundle,
    compare_teams,
    data_picklist,
    event_teams,
    rank_teams,
    scout_disagreements,
    team_entries,
    team_heatmap,
    team_summary,
)
from ..auth import require_admin
from ..config import settings
from ..database import database_dependency
from ..external import sync_event_matches
from ..realtime import emit
from ..store import all_settings, get_setting, set_setting
from ..views import ScouterView, list_matches, list_scouters, scouter_names
from .betting import bet_dict, resolve_match_bets
from .teams import entry_report

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _youtube_id(value: str) -> str:
    value = (value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return value
    match = re.search(r"(?:v=|/embed/|youtu\.be/|/v/|/shorts/)([A-Za-z0-9_-]{11})", value)
    return match.group(1) if match else value


def _settle_finished_matches(db: Database, event_key: str) -> int:
    settled = 0
    for match in list_matches(db, event_key):
        if match.winner is not None:
            settled += resolve_match_bets(db, match)
    return settled


@router.get("/settings")
def get_settings(
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    s = all_settings(db)
    return {
        "current_event": s.get("current_event", ""),
        "current_match": int(s.get("current_match", "0") or 0),
        "betting_enabled": s.get("betting_enabled", "1") == "1",
        "season": settings.season,
        "is_azure": False,
        "is_vercel": settings.is_vercel,
    }


class EventIn(BaseModel):
    event_key: str


@router.post("/event")
def set_event(
    body: EventIn,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    event_key = body.event_key.strip().lower()
    if event_key and not re.fullmatch(r"\d{4}[a-z0-9]+", event_key):
        raise HTTPException(
            status_code=400,
            detail="Event key must look like 2026txaus (year + TBA short name)",
        )
    previous = get_setting(db, "current_event")
    set_setting(db, "current_event", event_key)
    if event_key != previous:
        # New event → the old field pointer is meaningless.
        set_setting(db, "current_match", "0")
    matches = sync_event_matches(db, event_key) if event_key else []
    settled = _settle_finished_matches(db, event_key) if event_key else 0
    emit(db, "settings_changed", {"current_event": event_key})
    return {"ok": True, "event": event_key, "matches": len(matches), "bets_settled": settled}


class CurrentMatchIn(BaseModel):
    match_number: int


@router.post("/current-match")
def set_current_match(
    body: CurrentMatchIn,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    set_setting(db, "current_match", str(body.match_number))
    # Pull fresh results and settle any matches that just finished.
    event_key = get_setting(db, "current_event")
    settled = 0
    if event_key:
        sync_event_matches(db, event_key)
        settled = _settle_finished_matches(db, event_key)
    emit(db, "match_advanced", {"current_match": body.match_number})
    return {"ok": True, "current_match": body.match_number, "bets_settled": settled}


class ToggleIn(BaseModel):
    enabled: bool


@router.post("/betting/toggle")
def toggle_betting(
    body: ToggleIn,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    set_setting(db, "betting_enabled", "1" if body.enabled else "0")
    emit(db, "settings_changed", {"betting_enabled": body.enabled})
    return {"ok": True, "betting_enabled": body.enabled}


@router.post("/betting/reset")
def reset_betting(
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    """Wipe all bets and reset every scouter to the starting balance."""
    db.bets.delete_many({})
    db.scouters.update_many(
        {},
        {
            "$set": {
                "bucks": settings.starting_bucks,
                "updated_at": datetime.now(UTC),
            }
        },
    )
    emit(db, "betting_reset", {})
    return {"ok": True, "starting": settings.starting_bucks}


@router.get("/bets")
def list_bets(
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> list[dict]:
    rows = list(db.bets.find({}).sort("created_at", -1))
    names = scouter_names(db, (str(b.get("scouter_id")) for b in rows))
    out = []
    for b in rows:
        d = bet_dict(b)
        d["scout_name"] = names.get(str(b.get("scouter_id")), b.get("scouter_id"))
        out.append(d)
    return out


@router.delete("/bets/{bet_id}")
def delete_bet(
    bet_id: str,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    bet = db.bets.find_one({"_id": bet_id})
    if not bet:
        raise HTTPException(status_code=404, detail="Bet not found")
    adjust = 0
    if bet.get("status") in ("open", "lost"):
        adjust = int(bet.get("wager", 0))
    elif bet.get("status") == "won":
        adjust = -max(0, int(bet.get("payout", 0)) - int(bet.get("wager", 0)))
    scouter = None
    if adjust:
        scouter = db.scouters.find_one_and_update(
            {"_id": bet.get("scouter_id")},
            {"$inc": {"bucks": adjust}},
            return_document=True,
        )
    else:
        scouter = db.scouters.find_one({"_id": bet.get("scouter_id")})
    db.bets.delete_one({"_id": bet_id})
    emit(db, "bet_deleted", {"id": bet_id})
    return {"ok": True, "bucks": int(scouter["bucks"]) if scouter else None}


class FilmIn(BaseModel):
    match_key: str
    youtube_key: str = ""
    film_summary: str | None = None
    film_events: list[dict] | None = None


@router.post("/match/youtube")
def set_film(
    body: FilmIn,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    """Save the film for a match: video link, written takeaway, and the
    timestamped key-events play-by-play."""
    update: dict[str, Any] = {
        "youtube_key": _youtube_id(body.youtube_key),
        "updated_at": datetime.now(UTC),
    }
    if body.film_summary is not None:
        update["film_summary"] = body.film_summary
    if body.film_events is not None:
        update["film_events"] = body.film_events
    result = db.matches.update_one({"_id": body.match_key}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Match not found")
    emit(db, "film_updated", {"match_key": body.match_key})
    return {"ok": True}


@router.post("/match/result")
def set_result(
    _: ScouterView = Depends(require_admin),
) -> dict:
    raise HTTPException(status_code=400, detail="Manual result setting is disabled. Winners are pulled from TBA.")


# --------------------------------------------------------------------------- #
# Analytics                                                                    #
# --------------------------------------------------------------------------- #
@router.get("/metrics")
def metrics(_: ScouterView = Depends(require_admin)) -> dict:
    return {"metrics": [{"key": k, "label": v} for k, v in RANK_METRICS.items()]}


@router.get("/analysis")
def get_analysis(
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    return analysis_bundle(db, (event or get_setting(db, "current_event")).strip())


@router.get("/event-teams")
def list_event_teams(
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> list[int]:
    event_key = (event or get_setting(db, "current_event")).strip()
    return event_teams(db, event_key)


@router.get("/rank")
def rank(
    metric: str = "avg_points",
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(db, "current_event")).strip()
    return {"metric": metric, "teams": rank_teams(db, event_key, metric)}


@router.get("/data-picklist")
def get_data_picklist(
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(db, "current_event")).strip()
    return data_picklist(db, event_key)


@router.get("/disagreements")
def get_disagreements(
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    """Consensus radar: teams where scouts disagree with each other, or the
    numbers disagree with the qualitative reads."""
    event_key = (event or get_setting(db, "current_event")).strip()
    return scout_disagreements(db, event_key)


@router.get("/compare")
def compare(
    teams: str,
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(db, "current_event")).strip()
    nums = []
    for part in teams.split(","):
        part = part.strip()
        if part.isdigit():
            nums.append(int(part))
    nums = nums[:6]
    return compare_teams(db, event_key, nums)


@router.get("/team/{team}/summary")
def get_team_summary(
    team: int,
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(db, "current_event")).strip()
    return team_summary(db, event_key, team)


@router.get("/team/{team}/heatmap")
def get_team_heatmap(
    team: int,
    phase: str | None = None,
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> dict:
    event_key = (event or get_setting(db, "current_event")).strip()
    return team_heatmap(db, event_key, team, phase)


@router.get("/team/{team}/reports")
def get_team_reports(
    team: int,
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> list[dict]:
    event_key = (event or get_setting(db, "current_event")).strip()
    rows = team_entries(db, event_key, team)
    names = scouter_names(db, (e.scout_id for e in rows))
    return [entry_report(e, names.get(e.scout_id, e.scout_id)) for e in rows]


@router.get("/scouters")
def scouters(
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(require_admin),
) -> list[dict]:
    out = []
    for s in list_scouters(db):
        out.append(
            {
                "scout_id": s.scout_id,
                "s_number": s.s_number,
                "display_name": s.display_name,
                "is_admin": s.is_admin,
                "bucks": s.bucks,
                "matches_scouted": s.matches_scouted,
                "last_seen": s.last_seen.isoformat(),
            }
        )
    out.sort(key=lambda r: -r["matches_scouted"])
    return out
