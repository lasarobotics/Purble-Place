"""The Blue Alliance + Statbotics clients.

All responses are cached in the ``ExternalCache`` table.  Fresh data is
fetched when the cache is older than ``EXTERNAL_TTL_SECONDS``; if the network
is unavailable we fall back to whatever we cached previously (offline
resilience for events with flaky connectivity).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from sqlmodel import Session

from .config import settings
from .models import ExternalCache, MatchRecord, TeamCache


def team_key(team_number: int) -> str:
    return f"frc{team_number}"


async def _get_json(
    session: Session,
    url: str,
    headers: Optional[dict] = None,
    ttl: Optional[int] = None,
) -> Optional[Any]:
    ttl = settings.EXTERNAL_TTL_SECONDS if ttl is None else ttl
    cached = session.get(ExternalCache, url)
    now = datetime.now(timezone.utc)
    if cached is not None:
        age = (now - cached.fetched_at.replace(tzinfo=timezone.utc)).total_seconds()
        if age < ttl:
            return cached.payload

    # A User-Agent is REQUIRED — The Blue Alliance sits behind Cloudflare, which
    # blocks requests with no UA (HTTP 403, error 1010).
    req_headers = {"User-Agent": "HazeHub/1.0 (FRC scouting platform)"}
    req_headers.update(headers or {})

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url, headers=req_headers)
        if resp.status_code == 200:
            payload = resp.json()
            row = cached or ExternalCache(url=url)
            row.payload = payload
            row.fetched_at = now
            session.add(row)
            session.commit()
            return payload
        if resp.status_code == 404:
            return None
    except Exception:
        pass  # network down — fall through to stale cache

    return cached.payload if cached is not None else None


async def tba(session: Session, path: str, ttl: Optional[int] = None) -> Optional[Any]:
    return await _get_json(
        session,
        f"{settings.TBA_BASE}{path}",
        headers={"accept": "application/json", "X-TBA-Auth-Key": settings.TBA_KEY},
        ttl=ttl,
    )


async def statbotics(session: Session, path: str, ttl: Optional[int] = None) -> Optional[Any]:
    return await _get_json(
        session,
        f"{settings.STATBOTICS_BASE}{path}",
        headers={"accept": "application/json"},
        ttl=ttl,
    )


# --------------------------------------------------------------------------- #
# Higher level helpers                                                         #
# --------------------------------------------------------------------------- #
async def sync_event_matches(session: Session, event_key: str) -> list[MatchRecord]:
    """Pull the match schedule for an event into MatchRecord rows.

    Uses the full ``/matches`` endpoint (not ``/simple``) so we also capture
    the YouTube match videos for the Film tab.
    """
    data = await tba(session, f"/event/{event_key}/matches")
    out: list[MatchRecord] = []
    if not data:
        return out
    for m in data:
        mk = m["key"]
        existing = _match_by_key(session, mk)
        rec = existing or MatchRecord(match_key=mk, event_key=event_key)
        rec.comp_level = m.get("comp_level", "qm")
        rec.match_number = m.get("match_number", 0)
        alliances = m.get("alliances", {}) or {}
        red = alliances.get("red", {}) or {}
        blue = alliances.get("blue", {}) or {}
        rec.red = [int(t[3:]) for t in red.get("team_keys", []) if t.startswith("frc")]
        rec.blue = [int(t[3:]) for t in blue.get("team_keys", []) if t.startswith("frc")]
        rs, bs = red.get("score"), blue.get("score")
        rec.red_score = rs if rs not in (None, -1) else None
        rec.blue_score = bs if bs not in (None, -1) else None
        if rec.red_score is not None and rec.blue_score is not None:
            if rec.red_score > rec.blue_score:
                rec.winner = "red"
            elif rec.blue_score > rec.red_score:
                rec.winner = "blue"
            else:
                rec.winner = "tie"
        rec.predicted_time = m.get("predicted_time") or m.get("time")
        # Capture the YouTube match video (don't clobber a manual override).
        if not rec.youtube_key:
            for v in m.get("videos") or []:
                if v.get("type") == "youtube" and v.get("key"):
                    rec.youtube_key = v["key"]
                    break
        rec.updated_at = datetime.now(timezone.utc)
        session.add(rec)
        out.append(rec)
    session.commit()
    return out


def _match_by_key(session: Session, mk: str) -> Optional[MatchRecord]:
    from sqlmodel import select

    return session.exec(select(MatchRecord).where(MatchRecord.match_key == mk)).first()


async def sync_team(session: Session, team_number: int, season: Optional[int] = None) -> TeamCache:
    """Fetch profile, media (avatar + robot photos) and EPA for one team."""
    season = season or settings.SEASON
    tc = session.get(TeamCache, team_number) or TeamCache(team_number=team_number)

    info = await tba(session, f"/team/{team_key(team_number)}", ttl=86400)
    if info:
        tc.nickname = info.get("nickname") or tc.nickname
        tc.name = info.get("name") or tc.name
        tc.city = info.get("city") or ""
        tc.state = info.get("state_prov") or ""
        tc.country = info.get("country") or ""
        tc.rookie_year = info.get("rookie_year")

    media = await tba(session, f"/team/{team_key(team_number)}/media/{season}", ttl=86400)
    if media:
        photos: list[str] = []
        for item in media:
            mtype = item.get("type")
            details = item.get("details") or {}
            if mtype == "avatar" and details.get("base64Image"):
                tc.avatar = f"data:image/png;base64,{details['base64Image']}"
            else:
                url = item.get("direct_url") or item.get("view_url")
                if url and any(
                    mtype == t for t in ("imgur", "instagram-image", "cdphotothread", "grabcad")
                ):
                    photos.append(url)
        if photos:
            tc.photos = photos[:8]

    sb = await statbotics(session, f"/team_year/{team_number}/{season}", ttl=3600)
    if sb:
        try:
            tc.epa = sb.get("epa", {}).get("total_points", {}).get("mean")
        except Exception:
            tc.epa = None

    tc.updated_at = datetime.now(timezone.utc)
    session.add(tc)
    session.commit()
    session.refresh(tc)
    return tc


async def match_win_prob(session: Session, match_key: str) -> Optional[float]:
    """Statbotics predicted probability that **red** wins ``match_key``."""
    sb = await statbotics(session, f"/match/{match_key}", ttl=600)
    if not sb:
        return None
    pred = sb.get("pred") or {}
    prob = pred.get("red_win_prob")
    if prob is None:
        return None
    try:
        return float(prob)
    except (TypeError, ValueError):
        return None
