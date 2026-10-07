"""The Blue Alliance + Statbotics clients.

Responses are cached **in process** with a TTL and a stale-fallback, so a
flaky venue connection never breaks a page. The cache is deliberately not
persisted to Firestore: it would be a document write per upstream response
(hundreds a day) to duplicate data that already lands in the ``matches`` and
``team_cache`` collections, which *are* durable. A restart just refetches
from TBA, which is free and fast.
"""
from __future__ import annotations

import threading
import time
from datetime import date, datetime, timezone
from typing import Any, Optional

import httpx

from . import repo
from .config import settings
from .models import Event, MatchRecord, TeamCache
from .schema import match_id

# url -> (payload, fetched_at_monotonic)
_cache: dict[str, tuple[Any, float]] = {}
_cache_lock = threading.Lock()
#: Bound the cache so a long event can't grow it without limit.
MAX_CACHE_ENTRIES = 2000


def team_key(team_number: int) -> str:
    return f"frc{team_number}"


def _cache_get(url: str) -> tuple[Optional[Any], float]:
    with _cache_lock:
        hit = _cache.get(url)
    if hit is None:
        return None, 0.0
    payload, fetched = hit
    return payload, time.monotonic() - fetched


def _cache_put(url: str, payload: Any) -> None:
    with _cache_lock:
        if len(_cache) >= MAX_CACHE_ENTRIES:
            oldest = min(_cache, key=lambda k: _cache[k][1])
            _cache.pop(oldest, None)
        _cache[url] = (payload, time.monotonic())


async def _get_json(
    url: str,
    headers: Optional[dict] = None,
    ttl: Optional[int] = None,
) -> Optional[Any]:
    ttl = settings.EXTERNAL_TTL_SECONDS if ttl is None else ttl
    cached, age = _cache_get(url)
    if cached is not None and age < ttl:
        return cached

    # A User-Agent is REQUIRED: The Blue Alliance sits behind Cloudflare, which
    # blocks requests with no UA (HTTP 403, error 1010).
    req_headers = {"User-Agent": "HazeHub/1.0 (FRC scouting platform)"}
    req_headers.update(headers or {})

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url, headers=req_headers)
        if resp.status_code == 200:
            payload = resp.json()
            _cache_put(url, payload)
            return payload
        if resp.status_code == 404:
            return None
    except Exception:  # noqa: BLE001: network down; fall through to stale cache
        pass

    return cached


async def tba(path: str, ttl: Optional[int] = None) -> Optional[Any]:
    return await _get_json(
        f"{settings.TBA_BASE}{path}",
        headers={"accept": "application/json", "X-TBA-Auth-Key": settings.TBA_KEY},
        ttl=ttl,
    )


async def statbotics(path: str, ttl: Optional[int] = None) -> Optional[Any]:
    return await _get_json(
        f"{settings.STATBOTICS_BASE}{path}",
        headers={"accept": "application/json"},
        ttl=ttl,
    )


# --------------------------------------------------------------------------- #
# Higher level helpers                                                         #
# --------------------------------------------------------------------------- #
async def sync_event_matches(event_key: str) -> list[MatchRecord]:
    """Pull the match schedule for an event into ``matches`` documents.

    Uses the full ``/matches`` endpoint (not ``/simple``) so we also capture
    the YouTube match videos for the Film tab.

    This runs every time an admin advances the current match, so it is written
    to be nearly free: the rows are diffed against the cached copies and
    ``repo.save_matches`` only commits the ones that actually changed. A
    typical advance writes 1-2 documents instead of the whole 120-match
    schedule.
    """
    data = await tba(f"/event/{event_key}/matches")
    await sync_event_info(event_key)
    if not data:
        return repo.matches_for_event(event_key)

    out: list[MatchRecord] = []
    for m in data:
        comp_level = m.get("comp_level", "qm")
        match_number = int(m.get("match_number", 0) or 0)
        mk = m.get("key") or match_id(event_key, comp_level, match_number)
        rec = repo.match_by_key(mk) or MatchRecord(match_key=mk, event_key=event_key)
        rec.event_key = event_key
        rec.comp_level = comp_level
        rec.match_number = match_number
        alliances = m.get("alliances", {}) or {}
        red = alliances.get("red", {}) or {}
        blue = alliances.get("blue", {}) or {}
        rec.set_alliances(
            [int(t[3:]) for t in red.get("team_keys", []) if t.startswith("frc")],
            [int(t[3:]) for t in blue.get("team_keys", []) if t.startswith("frc")],
        )
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
        out.append(rec)

    repo.save_matches(out)
    return out


async def sync_event_info(event_key: str) -> None:
    """Upsert the events document (start_date + name from TBA, best effort)."""
    row = repo.event(event_key) or Event(event_key=event_key)
    info = await tba(f"/event/{event_key}")
    if info:
        row.name = info.get("name") or row.name
        try:
            row.start_date = date.fromisoformat(info["start_date"])
        except (KeyError, TypeError, ValueError):
            pass
    repo.save_event(row)


async def sync_team(team_number: int, season: Optional[int] = None) -> TeamCache:
    """Fetch profile, media (avatar + robot photos) and EPA for one team."""
    season = season or settings.SEASON
    tc = repo.team(team_number) or TeamCache(team_number=team_number)

    info = await tba(f"/team/{team_key(team_number)}", ttl=86400)
    if info:
        tc.nickname = info.get("nickname") or tc.nickname
        tc.name = info.get("name") or tc.name
        tc.city = info.get("city") or ""
        tc.state = info.get("state_prov") or ""
        tc.country = info.get("country") or ""
        tc.rookie_year = info.get("rookie_year")

    media = await tba(f"/team/{team_key(team_number)}/media/{season}", ttl=86400)
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

    sb = await statbotics(f"/team_year/{team_number}/{season}", ttl=3600)
    if sb:
        # Statbotics has shipped two shapes for this field:
        #   v3 (2025):  epa.total_points = {"mean": 55.1, ...}
        #   v3 (2026):  epa.total_points = 112.62
        raw = (sb.get("epa") or {}).get("total_points")
        if isinstance(raw, dict):
            tc.epa = raw.get("mean")
        elif isinstance(raw, (int, float)):
            tc.epa = float(raw)
        else:
            tc.epa = None

    tc.updated_at = datetime.now(timezone.utc)
    repo.save_team(tc)
    return tc


async def match_win_prob(match_key: str) -> Optional[float]:
    """Statbotics predicted probability that **red** wins ``match_key``."""
    sb = await statbotics(f"/match/{match_key}", ttl=600)
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


def cache_stats() -> dict[str, Any]:
    with _cache_lock:
        return {"entries": len(_cache), "max_entries": MAX_CACHE_ENTRIES}
