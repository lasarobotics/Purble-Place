"""Admin: event/match control, betting management, analytics."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from .. import repo
from ..analytics import (
    RANK_METRICS,
    analysis_bundle,
    compare_teams,
    data_analysis,
    data_picklist,
    event_teams,
    rank_teams,
    scout_disagreements,
    team_entries,
    team_heatmap,
    team_summary,
)
from ..archive import archive_event, archive_if_worthwhile
from ..auth import require_admin, require_full_admin
from ..config import settings
from ..external import sync_event_matches
from ..firestore_db import guard
from ..models import ROLE_ADMIN, ROLE_SCOUTER, ROLE_STRATEGY, ROLE_PICKLIST, ROLES, Bet, Scouter
from ..realtime import emit
from .betting import resolve_match_bets
from .teams import report_dict, scout_name

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _youtube_id(value: str) -> str:
    value = (value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return value
    match = re.search(r"(?:v=|/embed/|youtu\.be/|/v/|/shorts/)([A-Za-z0-9_-]{11})", value)
    return match.group(1) if match else value


def _settle_finished_matches(event_key: str) -> int:
    settled = 0
    for match in repo.matches_for_event(event_key):
        if match.winner is not None:
            settled += resolve_match_bets(match)
    return settled


@router.get("/settings")
def get_settings(_: Scouter = Depends(require_admin)) -> dict:
    s = repo.all_settings()
    return {
        "current_event": s.get("current_event", ""),
        "current_match": int(s.get("current_match", "0") or 0),
        "betting_enabled": s.get("betting_enabled", "1") == "1",
        "post_comp_mode": s.get("post_comp_mode", "0") == "1",
        "season": settings.SEASON,
        "environment": settings.ENVIRONMENT,
    }


class EventIn(BaseModel):
    event_key: str


@router.post("/event")
async def set_event(
    body: EventIn,
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = body.event_key.strip()
    # Freeze the outgoing event first. Switching is the moment its records
    # stop being readable from the cache, so this is the last chance to roll
    # them up cheaply, and doing it here means nobody has to remember to.
    previous = repo.current_event()
    archived = None
    if previous and previous != event_key:
        rolled = archive_if_worthwhile(previous)
        archived = rolled.event_key if rolled else None
    # This re-scopes the event-filtered caches, which costs one full read of
    # the new event's documents: the only bulk read outside a cold start.
    repo.set_setting("current_event", event_key)
    matches = await sync_event_matches(event_key) if event_key else []
    settled = _settle_finished_matches(event_key) if event_key else 0
    emit("settings_changed", {"current_event": event_key})
    return {
        "ok": True,
        "event": event_key,
        "matches": len(matches),
        "bets_settled": settled,
        "archived": archived,
    }


class CurrentMatchIn(BaseModel):
    match_number: int


@router.post("/current-match")
async def set_current_match(
    body: CurrentMatchIn,
    _: Scouter = Depends(require_admin),
) -> dict:
    repo.set_setting("current_match", str(body.match_number))
    # Pull fresh results and settle any matches that just finished. The
    # schedule sync only writes matches whose data actually changed.
    event_key = repo.current_event()
    settled = 0
    if event_key:
        await sync_event_matches(event_key)
        settled = _settle_finished_matches(event_key)
    emit("match_advanced", {"current_match": body.match_number})
    return {"ok": True, "current_match": body.match_number, "bets_settled": settled}


class ToggleIn(BaseModel):
    enabled: bool


class ArchiveResetIn(BaseModel):
    name: str = ""


def _set_post_comp_unlock_cookie(response: Response) -> None:
    response.set_cookie(
        "post_comp_unlocked",
        "1",
        max_age=60 * 60 * 24,
        httponly=False,
        samesite="lax",
        path="/",
    )


@router.post("/betting/toggle")
def toggle_betting(
    body: ToggleIn,
    _: Scouter = Depends(require_admin),
) -> dict:
    repo.set_setting("betting_enabled", "1" if body.enabled else "0")
    emit("settings_changed", {"betting_enabled": body.enabled})
    return {"ok": True, "betting_enabled": body.enabled}


@router.post("/post-comp/toggle")
def toggle_post_comp(
    body: ToggleIn,
    response: Response,
    _: Scouter = Depends(require_admin),
) -> dict:
    repo.set_setting("post_comp_mode", "1" if body.enabled else "0")
    if body.enabled:
        _set_post_comp_unlock_cookie(response)
    else:
        response.delete_cookie("post_comp_unlocked", path="/")
    emit("settings_changed", {"post_comp_mode": body.enabled})
    return {"ok": True, "post_comp_mode": body.enabled}


@router.post("/betting/reset")
def reset_betting(_: Scouter = Depends(require_admin)) -> dict:
    """Wipe all bets and reset every scouter to the starting balance.

    Both halves run as batched commits (chunked below Firestore's 500
    operations per commit), so resetting a full event is a few commits rather
    than hundreds of individual writes.
    """
    deleted = repo.delete_all_bets()
    rows = repo.scouters()
    for s in rows:
        s.bucks = settings.STARTING_BUCKS
    repo.save_scouters(rows)
    emit("betting_reset", {})
    return {"ok": True, "starting": settings.STARTING_BUCKS, "bets_deleted": deleted}


def _admin_bet_dict(bet: Bet) -> dict:
    return {
        "id": bet.id,
        "scout_id": bet.scout_id,
        "scout_name": scout_name(bet.scout_id),
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
def list_bets(_: Scouter = Depends(require_admin)) -> list[dict]:
    return [_admin_bet_dict(bet) for bet in repo.bets()]


@router.delete("/bets/{bet_id}")
def delete_bet(
    bet_id: int,
    _: Scouter = Depends(require_admin),
) -> dict:
    bet = repo.bet(bet_id)
    if not bet:
        raise HTTPException(status_code=404, detail="Bet not found")
    scouter = repo.scouter(bet.scout_id)
    if scouter:
        if bet.status in ("open", "lost"):
            scouter.bucks += bet.wager
        elif bet.status == "won":
            scouter.bucks -= max(0, bet.payout - bet.wager)
        repo.save_scouter(scouter)
    repo.delete_bet(bet_id)
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
    _: Scouter = Depends(require_admin),
) -> dict:
    """Save the film for a match: video link, written takeaway, and the
    timestamped key-events play-by-play."""
    m = repo.match_by_key(body.match_key)
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    m.youtube_key = _youtube_id(body.youtube_key)
    if body.film_summary is not None:
        m.film_summary = body.film_summary
    if body.film_events is not None:
        m.film_events = body.film_events
    repo.save_match(m)
    emit("film_updated", {"match_key": body.match_key})
    return {"ok": True}


@router.post("/match/result")
def set_result(_: Scouter = Depends(require_admin)) -> dict:
    raise HTTPException(status_code=400, detail="Manual result setting is disabled. Winners are pulled from TBA.")


# --------------------------------------------------------------------------- #
# Analytics                                                                    #
# --------------------------------------------------------------------------- #
@router.get("/metrics")
def metrics(_: Scouter = Depends(require_admin)) -> dict:
    return {"metrics": [{"key": k, "label": v} for k, v in RANK_METRICS.items()]}


@router.get("/analysis")
def get_analysis(
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> dict:
    return analysis_bundle(repo.resolve_event(event))


@router.get("/event-teams")
def list_event_teams(
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> list[int]:
    return event_teams(repo.resolve_event(event))


@router.get("/rank")
async def rank(
    metric: str = "avg_points",
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = repo.resolve_event(event)
    return {"metric": metric, "teams": rank_teams(event_key, metric)}


@router.get("/data-analysis")
async def get_data_analysis(
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> dict:
    return {"teams": data_analysis(repo.resolve_event(event))}


@router.get("/data-picklist")
async def get_data_picklist(
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> dict:
    return data_picklist(repo.resolve_event(event))


@router.get("/disagreements")
def get_disagreements(
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> dict:
    """Consensus radar: teams where scouts disagree with each other, or the
    numbers disagree with the qualitative reads."""
    return scout_disagreements(repo.resolve_event(event))


@router.get("/compare")
async def compare(
    teams: str,
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = repo.resolve_event(event)
    nums = []
    for part in teams.split(","):
        part = part.strip()
        if part.isdigit():
            nums.append(int(part))
    nums = nums[:6]
    return compare_teams(event_key, nums)


@router.get("/team/{team}/summary")
async def get_team_summary(
    team: int,
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> dict:
    return team_summary(repo.resolve_event(event), team)


@router.get("/team/{team}/heatmap")
def get_team_heatmap(
    team: int,
    phase: str | None = None,
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> dict:
    return team_heatmap(repo.resolve_event(event), team, phase)


@router.get("/team/{team}/reports")
def get_team_reports(
    team: int,
    event: str | None = None,
    _: Scouter = Depends(require_admin),
) -> list[dict]:
    event_key = repo.resolve_event(event)
    return [
        report_dict(entry, scout_name(entry.scout_id))
        for entry in team_entries(event_key, team)
    ]


@router.get("/scouters")
def scouters(_: Scouter = Depends(require_admin)) -> list[dict]:
    out = []
    for s in repo.scouters():
        seen = repo.last_seen(s)
        out.append(
            {
                "scout_id": s.scout_id,
                "s_number": s.s_number,
                "display_name": s.display_name or s.scout_id,
                "role": s.role,
                "is_admin": s.is_admin,
                "bucks": s.bucks,
                "matches_scouted": s.matches_scouted,
                "last_seen": seen.isoformat() if seen else None,
            }
        )
    out.sort(key=lambda r: -r["matches_scouted"])
    return out


class RoleIn(BaseModel):
    role: str


@router.post("/scouters/{scout_id}/role")
def set_role(
    scout_id: str,
    body: RoleIn,
    admin: Scouter = Depends(require_full_admin),
) -> dict:
    """Change an account's role.

    Admin only, not strategy: letting strategy accounts promote each other
    would make the distinction meaningless.
    """
    role = (body.role or "").strip().lower()
    if role not in ROLES:
        raise HTTPException(
            status_code=400, detail=f"Role must be one of {', '.join(ROLES)}"
        )
    target = repo.scouter(scout_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Scouter not found")
    if target.scout_id == admin.scout_id and role != ROLE_ADMIN:
        # Otherwise the last admin can lock everyone out of event control.
        raise HTTPException(
            status_code=400, detail="You cannot remove your own admin role"
        )
    target.role = role
    repo.save_scouter(target)
    emit("roles_changed", {"scout_id": target.scout_id, "role": role})
    return {"ok": True, "scout_id": target.scout_id, "role": role}


@router.get("/roles")
def list_roles(_: Scouter = Depends(require_admin)) -> dict:
    return {
        "roles": [
            {"key": ROLE_SCOUTER, "label": "Scouter",
             "description": "Collects match and pit data. Builds their own picklists."},
            {"key": ROLE_STRATEGY, "label": "Strategy",
             "description": "Everything a scouter does, plus all analysis screens. "
                            "Their picklists outrank scouter lists in the meeting."},
            {"key": ROLE_ADMIN, "label": "Admin",
             "description": "Strategy, plus event control, film and account roles."},
            {"key": ROLE_PICKLIST, "label": "Picklist meeting",
             "description": "Shared screen account for the picklist meeting. "
                            "Can only view teams and edit picklists."},
        ]
    }


# --------------------------------------------------------------------------- #
# Firestore quota                                                              #
# --------------------------------------------------------------------------- #
@router.get("/firestore-usage")
def firestore_usage(_: Scouter = Depends(require_admin)) -> dict:
    """Where today's Firestore document operations went.

    ``projected_12h`` extrapolates the current rate over a full competition
    day: if it stays under the free-tier limits, the event costs nothing.
    """
    return {
        **guard.snapshot(),
        "cache": repo.cache_stats(),
        "note": (
            "Reads are dominated by the one-time load at startup; steady-state "
            "requests are served from memory. Writes track actual submissions."
        ),
    }


@router.post("/cache/reload")
def reload_cache(_: Scouter = Depends(require_admin)) -> dict:
    """Re-read the current event from Firestore.

    Only needed if data was changed outside this service (a console edit, a
    manual import). Costs one read per document in the event.
    """
    event_key = repo.current_event()
    from ..cache import store

    store.retarget_event("")
    store.retarget_event(event_key)
    repo.invalidate_memo()
    return {"ok": True, "event": event_key, "cache": repo.cache_stats()}


# --------------------------------------------------------------------------- #
# Event archives                                                               #
# --------------------------------------------------------------------------- #
def _archive_dict(row) -> dict:
    return {
        "event_key": row.event_key,
        "name": row.name,
        "season": row.season,
        "game_name": row.game_name,
        "archived_at": row.archived_at.isoformat(),
        "counts": row.counts,
        "teams": row.teams,
        "pit": row.pit,
        "picklists": row.picklists,
        "event": row.event,
        "matches": row.matches,
        "scouting": row.scouting,
        "pit_raw": row.pit_raw,
        "picklists_raw": row.picklists_raw,
        "bets": row.bets,
        "team_cache": row.team_cache,
        "analytics": row.analytics,
        "chunk_ids": row.chunk_ids,
    }


@router.get("/archives")
def list_archives(_: Scouter = Depends(require_admin)) -> list[dict]:
    """Every event this installation has finished, newest first.

    Summaries only. The per-team detail is a second request, because the
    whole point of the archive is that the list stays small enough to load
    without thinking about it.
    """
    return [
        {
            "event_key": a.event_key,
            "name": a.name,
            "season": a.season,
            "game_name": a.game_name,
            "archived_at": a.archived_at.isoformat(),
            "counts": a.counts,
            "match_count": a.counts.get("matches", 0),
            "team_count": a.counts.get("teams", 0),
            "scouting_count": a.counts.get("scouting_entries", 0),
        }
        for a in repo.archives()
    ]


@router.get("/archives/{event_key}")
def get_archive(event_key: str, _: Scouter = Depends(require_admin)) -> dict:
    row = repo.archive_detail(event_key)
    if row is None:
        raise HTTPException(status_code=404, detail=f"No archive for {event_key}")
    return _archive_dict(row)


@router.post("/archives/{event_key}")
def create_archive(event_key: str, _: Scouter = Depends(require_admin)) -> dict:
    """Archive an event now.

    Normally this happens by itself when the current event changes. Doing it
    by hand is for taking a checkpoint mid-event, or for rebuilding an archive
    after late scouting has synced in. Re-running overwrites, so it is safe.
    """
    event_key = (event_key or "").strip()
    if event_key != repo.current_event() and not repo.event(event_key):
        raise HTTPException(status_code=404, detail=f"Unknown event {event_key}")
    row = archive_event(event_key)
    emit("event_archived", {"event": row.event_key})
    return {"ok": True, "event": row.event_key, "counts": row.counts}


@router.post("/archive-and-reset")
def archive_and_reset(
    body: ArchiveResetIn,
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = repo.current_event()
    if not event_key:
        raise HTTPException(status_code=400, detail="No current event is set.")

    row = archive_event(event_key, body.name.strip() or None)
    verified = repo.archive_detail(event_key)
    if (
        verified is None
        or verified.counts != row.counts
        or len(verified.scouting) != row.counts.get("scouting_entries", 0)
        or len(verified.matches) != row.counts.get("matches", 0)
    ):
        raise HTTPException(status_code=500, detail="Archive verification failed; active data was not cleared.")

    deleted = {
        "scouting": repo.delete_scouting_for_event(event_key),
        "matches": repo.delete_matches_for_event(event_key),
        "pit": repo.delete_pits_for_event(event_key),
        "picklists": repo.delete_picklists_for_event(event_key),
        "bets": repo.delete_bets_for_event(event_key),
    }
    repo.delete_event(event_key)
    repo.set_setting("current_event", "")
    repo.set_setting("current_match", "0")
    emit("settings_changed", {"current_event": "", "current_match": 0})
    emit("event_archived", {"event": event_key})
    return {"ok": True, "archive": _archive_dict(row), "deleted": deleted}
