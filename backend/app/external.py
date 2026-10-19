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
import asyncio
from weakref import WeakKeyDictionary
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
_flights: dict[tuple, asyncio.Task] = {}
_etags: dict[str, str] = {}
_retry_after: dict[str, float] = {}
_failures: dict[str, int] = {}
_revision = 0
_gates = WeakKeyDictionary()
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
    global _revision
    with _cache_lock:
        if _cache.get(url, (None,))[0] != payload:
            _revision += 1
        if len(_cache) >= MAX_CACHE_ENTRIES:
            oldest = min(_cache, key=lambda k: _cache[k][1])
            _cache.pop(oldest, None)
            _etags.pop(oldest, None)
            _retry_after.pop(oldest, None)
            _failures.pop(oldest, None)
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

    if _retry_after.get(url, 0) > time.monotonic():
        return cached
    key = (asyncio.get_running_loop(), url)
    task = _flights.get(key)
    if task is None:
        task = asyncio.create_task(_fetch_json(url, headers, cached))
        _flights[key] = task
        task.add_done_callback(lambda _: _flights.pop(key, None))
    # Last-known-good data is shown while one shared background request refreshes.
    if cached is not None:
        return cached
    return await asyncio.shield(task)


async def _fetch_json(url, headers, cached):
    loop = asyncio.get_running_loop()
    gate = _gates.setdefault(loop, asyncio.Semaphore(4))
    async with gate:
        return await _fetch_json_bounded(url, headers, cached)


async def _fetch_json_bounded(url, headers, cached):

    # A User-Agent is REQUIRED: The Blue Alliance sits behind Cloudflare, which
    # blocks requests with no UA (HTTP 403, error 1010).
    req_headers = {"User-Agent": "HazeHub/1.0 (FRC scouting platform)"}
    req_headers.update(headers or {})
    if url in _etags:
        req_headers["If-None-Match"] = _etags[url]

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url, headers=req_headers)
        if resp.status_code == 200:
            payload = resp.json()
            _cache_put(url, payload)
            if resp.headers.get("ETag"):
                _etags[url] = resp.headers["ETag"]
            _failures.pop(url, None)
            _retry_after.pop(url, None)
            return payload
        if resp.status_code == 304 and cached is not None:
            _cache_put(url, cached)
            return cached
        if resp.status_code == 429:
            try:
                _retry_after[url] = time.monotonic() + min(604800, max(60, float(resp.headers.get("Retry-After", "60"))))
            except ValueError:
                _retry_after[url] = time.monotonic() + 60
    except Exception:  # noqa: BLE001: network down; fall through to stale cache
        pass

    _failures[url] = min(6, _failures.get(url, 0) + 1)
    _retry_after[url] = max(_retry_after.get(url, 0), time.monotonic() + min(1800, 15 * 2 ** _failures[url]))
    if len(_failures) > MAX_CACHE_ENTRIES:
        oldest = next(iter(_failures))
        _failures.pop(oldest, None)
        _retry_after.pop(oldest, None)
    return cached


async def tba(path: str, ttl: Optional[int] = None) -> Optional[Any]:
    if not settings.TBA_KEY:
        return None
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


async def match13(path: str, ttl: Optional[int] = None) -> Optional[Any]:
    """Call Match 13 from the server so its bearer key never reaches a browser."""
    if not settings.MATCH13_KEY:
        return None
    return await _get_json(
        f"{settings.MATCH13_BASE}{path}",
        headers={"accept": "application/json", "Authorization": f"Bearer {settings.MATCH13_KEY}"},
        ttl=ttl,
    )


async def match13_event_ratings(event_key: str) -> dict[int, dict[str, Any]]:
    """Return the Match 13 event ratings and adjacent official event stats."""
    payload, rankings = await asyncio.gather(
        match13(f"/v1/events/{event_key}/teams", ttl=300),
        tba(f"/event/{event_key}/rankings", ttl=300),
    )
    rows = payload.get("teams", []) if isinstance(payload, dict) else []
    out: dict[int, dict[str, Any]] = {}

    def number(value: Any) -> Optional[float]:
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            team = int(row.get("teamNumber"))
        except (TypeError, ValueError):
            continue
        if team < 1:
            continue
        out[team] = {
            "opr": number(row.get("opr")),
            "match13_epa": number(row.get("epa")),
            "xp": number(row.get("xpEnd")),
            "x_auto": number(row.get("xAuto")),
            "x_tele": number(row.get("xTele")),
            "x_end": number(row.get("xEnd")),
            "match13_sos": number(row.get("sos")),
        }
    defaults = {"opr": None, "match13_epa": None, "xp": None, "x_auto": None,
                "x_tele": None, "x_end": None, "match13_sos": None}
    for row in (rankings or {}).get("rankings", []):
        key = str(row.get("team_key", ""))
        if not key.startswith("frc") or not key[3:].isdigit():
            continue
        target = out.setdefault(int(key[3:]), dict(defaults))
        record = row.get("record") or {}
        target["record"] = f"{int(record.get('wins', 0))}-{int(record.get('losses', 0))}-{int(record.get('ties', 0))}"
        orders = row.get("sort_orders") or []
        target["ranking_score"] = number(orders[0]) if orders else None

    scored: dict[int, list[float]] = {}
    records: dict[int, list[int]] = {}
    for completed in repo.matches_for_event(event_key):
        if completed.comp_level != "qm" or completed.red_score is None or completed.blue_score is None:
            continue
        for teams, score, other in ((completed.red, completed.red_score, completed.blue_score),
                                    (completed.blue, completed.blue_score, completed.red_score)):
            for team in teams:
                scored.setdefault(team, []).append(float(score))
                rec = records.setdefault(team, [0, 0, 0])
                rec[0 if score > other else 1 if score < other else 2] += 1
    for team in set(scored) | set(records):
        target = out.setdefault(team, dict(defaults))
        values = scored.get(team, [])
        target["avg_score"] = round(sum(values) / len(values), 2) if values else None
        if "record" not in target:
            wins, losses, ties = records.get(team, [0, 0, 0])
            target["record"] = f"{wins}-{losses}-{ties}"
    return out


# --------------------------------------------------------------------------- #
# Higher level helpers                                                         #
# --------------------------------------------------------------------------- #
async def sync_event_matches(event_key: str, ttl: Optional[int] = None) -> list[MatchRecord]:
    """Pull the match schedule for an event into ``matches`` documents.

    Uses the full ``/matches`` endpoint (not ``/simple``) so we also capture
    the YouTube match videos for the Film tab.

    This runs every time an admin advances the current match, so it is written
    to be nearly free: the rows are diffed against the cached copies and
    ``repo.save_matches`` only commits the ones that actually changed. A
    typical advance writes 1-2 documents instead of the whole 120-match
    schedule.
    """
    data = await tba(f"/event/{event_key}/matches", ttl=ttl)
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
