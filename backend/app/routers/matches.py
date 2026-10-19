"""Match schedule, current/on-deck match, pre-match team display."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException

from .. import repo
from ..auth import current_scouter
from ..external import sync_event_matches
from ..external import match13_event_ratings
from ..models import MatchRecord, Scouter
from ..config import settings

router = APIRouter(prefix="/api/matches", tags=["matches"])


def _youtube_id(value: str) -> str:
    value = (value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return value
    match = re.search(r"(?:v=|/embed/|youtu\.be/|/v/|/shorts/)([A-Za-z0-9_-]{11})", value)
    return match.group(1) if match else ""


def _youtube_embed_url(value: str) -> str:
    video_id = _youtube_id(value)
    return f"https://www.youtube.com/embed/{video_id}" if video_id else ""


def _match_dict(m: MatchRecord) -> dict:
    return {
        "match_key": m.match_key,
        "event_key": m.event_key,
        "comp_level": m.comp_level,
        "match_number": m.match_number,
        "red": m.red,
        "blue": m.blue,
        "red_score": m.red_score,
        "blue_score": m.blue_score,
        "winner": m.winner,
        "betting_locked": m.betting_locked,
        "youtube_key": m.youtube_key,
        "video_url": _youtube_embed_url(m.youtube_key),
        "film_summary": m.film_summary,
        "film_events": m.film_events,
        "predicted_time": m.predicted_time,
    }


def teams_payload(numbers: list[int]) -> list[dict]:
    """Team cards for an alliance: served entirely from the cache."""
    out = []
    for n in numbers:
        tc = repo.team(n)
        out.append(
            {
                "team_number": tc.team_number if tc else n,
                "nickname": tc.nickname if tc else "",
                "avatar": tc.avatar if tc else "",
                "photos": tc.photos if tc else [],
                "epa": tc.epa if tc else None,
                "city": tc.city if tc else "",
                "state": tc.state if tc else "",
            }
        )
    return out


@router.get("")
async def list_matches(
    event: str | None = None,
    refresh: bool = False,
    include_teams: bool = False,
    _: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(event)
    if not event_key:
        return {"event": "", "matches": []}
    existing = repo.matches_for_event(event_key)
    if refresh or not existing:
        await sync_event_matches(event_key, ttl=60 if refresh else None)
        existing = repo.matches_for_event(event_key)
    if not include_teams:
        return {"event": event_key, "matches": [_match_dict(m) for m in existing]}

    def enrich(m: MatchRecord) -> dict:
        d = _match_dict(m)
        d["red_teams"] = teams_payload(m.red)
        d["blue_teams"] = teams_payload(m.blue)
        return d

    return {"event": event_key, "matches": [enrich(m) for m in existing]}


@router.get("/event-board")
async def event_board(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """Public, frequently refreshed qualification schedule and results."""
    event_key = repo.resolve_event(event)
    if not event_key:
        return {"event": "", "matches": [], "home_teams": []}
    await sync_event_matches(event_key, ttl=60)
    matches = [m for m in repo.matches_for_event(event_key) if m.comp_level == "qm"]
    return {
        "event": event_key,
        "home_teams": settings.HOME_TEAMS,
        "matches": [_match_dict(m) for m in matches],
    }


@router.get("/event-ratings")
async def event_ratings(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """Public HazeHub proxy for Match 13; credentials stay on the server."""
    event_key = repo.resolve_event(event)
    try:
        ratings = await match13_event_ratings(event_key) if event_key else {}
    except Exception:  # noqa: BLE001 — upstream outage must not crash the page
        ratings = {}
    return {"event": event_key, "source": "match13", "teams": [
        {"team": team, **values} for team, values in sorted(ratings.items())
    ]}


@router.get("/current")
async def current_match(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """The match on the field + the next few, with full team detail for the
    pre-match waiting screen (avatars, robot photos, EPA)."""
    event_key = repo.resolve_event(event)
    if not event_key:
        return {"event": "", "current": None, "on_deck": []}
    matches = repo.matches_for_event(event_key)
    if not matches:
        await sync_event_matches(event_key)
        matches = repo.matches_for_event(event_key)

    cur_num = int(repo.setting("current_match") or 0)
    qm = [m for m in matches if m.comp_level == "qm"]
    current = next((m for m in qm if m.match_number == cur_num), None)
    on_deck = [m for m in qm if m.match_number > cur_num][:3]

    def enrich(m: MatchRecord) -> dict:
        d = _match_dict(m)
        d["red_teams"] = teams_payload(m.red)
        d["blue_teams"] = teams_payload(m.blue)
        return d

    return {
        "event": event_key,
        "current_number": cur_num,
        "current": enrich(current) if current else None,
        "on_deck": [enrich(m) for m in on_deck],
    }


@router.get("/{match_key}")
async def get_match(
    match_key: str,
    _: Scouter = Depends(current_scouter),
) -> dict:
    m = repo.match_by_key(match_key)
    if m is None:
        raise HTTPException(status_code=404, detail="Match not found")
    d = _match_dict(m)
    d["red_teams"] = teams_payload(m.red)
    d["blue_teams"] = teams_payload(m.blue)
    return d
