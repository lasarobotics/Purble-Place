"""Match schedule, current/on-deck match, pre-match team display."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from pymongo.database import Database

from ..auth import current_scouter
from ..database import database_dependency
from ..external import sync_event_matches
from ..store import get_setting
from ..views import (
    MatchView,
    ScouterView,
    TeamView,
    get_match,
    get_teams_cache,
    list_matches,
)

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


def _resolve_event(db: Database, event_key: str | None) -> str:
    return (event_key or get_setting(db, "current_event")).strip()


def match_dict(m: MatchView) -> dict:
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


def teams_payload(cache: dict[int, TeamView], numbers: list[int]) -> list[dict]:
    out = []
    for n in numbers:
        tc = cache.get(n)
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


def _team_cache_for(db: Database, matches: list[MatchView]) -> dict[int, TeamView]:
    numbers: set[int] = set()
    for m in matches:
        numbers.update(m.red)
        numbers.update(m.blue)
    return get_teams_cache(db, numbers)


def enrich(db: Database, matches: list[MatchView]) -> list[dict]:
    cache = _team_cache_for(db, matches)
    out = []
    for m in matches:
        d = match_dict(m)
        d["red_teams"] = teams_payload(cache, m.red)
        d["blue_teams"] = teams_payload(cache, m.blue)
        out.append(d)
    return out


@router.get("")
def list_event_matches(
    event: str | None = None,
    refresh: bool = False,
    include_teams: bool = False,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict:
    event_key = _resolve_event(db, event)
    if not event_key:
        return {"event": "", "matches": []}
    existing = list_matches(db, event_key)
    if refresh or not existing:
        sync_event_matches(db, event_key)
        existing = list_matches(db, event_key)
    if not include_teams:
        return {"event": event_key, "matches": [match_dict(m) for m in existing]}
    return {"event": event_key, "matches": enrich(db, existing)}


@router.get("/current")
def current_match(
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict:
    """The match on the field + the next few, with full team detail for the
    pre-match waiting screen (avatars, robot photos, EPA)."""
    event_key = _resolve_event(db, event)
    if not event_key:
        return {"event": "", "current": None, "on_deck": []}
    matches = list_matches(db, event_key)
    if not matches:
        sync_event_matches(db, event_key)
        matches = list_matches(db, event_key)

    cur_num = int(get_setting(db, "current_match") or 0)
    qm = [m for m in matches if m.comp_level == "qm"]
    current = next((m for m in qm if m.match_number == cur_num), None)
    on_deck = [m for m in qm if m.match_number > cur_num][:3]

    enriched = enrich(db, ([current] if current else []) + on_deck)
    current_payload = enriched.pop(0) if current else None

    return {
        "event": event_key,
        "current_number": cur_num,
        "current": current_payload,
        "on_deck": enriched,
    }


@router.get("/{match_key}")
def get_one_match(
    match_key: str,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict:
    m = get_match(db, match_key)
    if m is None:
        raise HTTPException(status_code=404, detail="Match not found")
    return enrich(db, [m])[0]
