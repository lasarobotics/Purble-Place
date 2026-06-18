"""Match schedule, current/on-deck match, pre-match team display."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..auth import current_scouter
from ..database import get_session
from ..external import sync_event_matches, sync_team
from ..models import MatchRecord, Scouter, TeamCache
from ..store import get_setting

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


def _resolve_event(session: Session, event_key: str | None) -> str:
    return (event_key or get_setting(session, "current_event")).strip()


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


def _sorted_matches(session: Session, event_key: str) -> list[MatchRecord]:
    order = {"qm": 0, "ef": 1, "qf": 2, "sf": 3, "f": 4}
    rows = list(
        session.exec(select(MatchRecord).where(MatchRecord.event_key == event_key)).all()
    )
    rows.sort(key=lambda m: (order.get(m.comp_level, 9), m.match_number))
    return rows


@router.get("")
async def list_matches(
    event: str | None = None,
    refresh: bool = False,
    include_teams: bool = False,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> dict:
    event_key = _resolve_event(session, event)
    if not event_key:
        return {"event": "", "matches": []}
    existing = _sorted_matches(session, event_key)
    if refresh or not existing:
        await sync_event_matches(session, event_key)
        existing = _sorted_matches(session, event_key)
    if not include_teams:
        return {"event": event_key, "matches": [_match_dict(m) for m in existing]}

    async def enrich(m: MatchRecord) -> dict:
        d = _match_dict(m)
        d["red_teams"] = await _teams_payload(session, m.red)
        d["blue_teams"] = await _teams_payload(session, m.blue)
        return d

    return {"event": event_key, "matches": [await enrich(m) for m in existing]}


async def _teams_payload(session: Session, numbers: list[int]) -> list[dict]:
    out = []
    for n in numbers:
        tc = session.get(TeamCache, n)
        if tc is None or not tc.avatar:
            tc = await sync_team(session, n)
        out.append(
            {
                "team_number": tc.team_number,
                "nickname": tc.nickname,
                "avatar": tc.avatar,
                "photos": tc.photos,
                "epa": tc.epa,
                "city": tc.city,
                "state": tc.state,
            }
        )
    return out


@router.get("/current")
async def current_match(
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> dict:
    """The match on the field + the next few, with full team detail for the
    pre-match waiting screen (avatars, robot photos, EPA)."""
    event_key = _resolve_event(session, event)
    if not event_key:
        return {"event": "", "current": None, "on_deck": []}
    matches = _sorted_matches(session, event_key)
    if not matches:
        await sync_event_matches(session, event_key)
        matches = _sorted_matches(session, event_key)

    cur_num = int(get_setting(session, "current_match") or 0)
    qm = [m for m in matches if m.comp_level == "qm"]
    current = next((m for m in qm if m.match_number == cur_num), None)
    on_deck = [m for m in qm if m.match_number > cur_num][:3]

    async def enrich(m: MatchRecord) -> dict:
        d = _match_dict(m)
        d["red_teams"] = await _teams_payload(session, m.red)
        d["blue_teams"] = await _teams_payload(session, m.blue)
        return d

    return {
        "event": event_key,
        "current_number": cur_num,
        "current": await enrich(current) if current else None,
        "on_deck": [await enrich(m) for m in on_deck],
    }


@router.get("/{match_key}")
async def get_match(
    match_key: str,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> dict:
    m = session.exec(
        select(MatchRecord).where(MatchRecord.match_key == match_key)
    ).first()
    if m is None:
        raise HTTPException(status_code=404, detail="Match not found")
    d = _match_dict(m)
    d["red_teams"] = await _teams_payload(session, m.red)
    d["blue_teams"] = await _teams_payload(session, m.blue)
    return d
