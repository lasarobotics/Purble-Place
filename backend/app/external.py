"""The Blue Alliance + Statbotics clients.

All responses are cached in the ``external_cache`` collection.  Fresh data is
fetched when the cache is older than ``external_ttl_seconds``; if the network
is unavailable we fall back to whatever we cached previously (offline
resilience for events with flaky connectivity).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Optional

import httpx
from pymongo.database import Database

from .config import settings
from .models import EventDocument, MatchDocument, TeamCacheDocument
from .repositories import HazeHubRepository, RepositoryError
from .views import MatchView


def team_key(team_number: int) -> str:
    return f"frc{team_number}"


def _get_json(
    db: Database,
    url: str,
    headers: Optional[dict] = None,
    ttl: Optional[int] = None,
) -> Optional[Any]:
    ttl = settings.external_ttl_seconds if ttl is None else ttl
    cached = db.external_cache.find_one({"_id": url})
    now = datetime.now(UTC)
    if cached is not None:
        fetched_at = cached.get("fetched_at") or datetime(1970, 1, 1, tzinfo=UTC)
        if fetched_at.tzinfo is None:
            fetched_at = fetched_at.replace(tzinfo=UTC)
        if (now - fetched_at).total_seconds() < ttl:
            return cached.get("payload")

    # A User-Agent is REQUIRED — The Blue Alliance sits behind Cloudflare,
    # which blocks requests with no UA (HTTP 403, error 1010).
    req_headers = {"User-Agent": "HazeHub/1.0 (FRC scouting platform)"}
    req_headers.update(headers or {})

    try:
        with httpx.Client(timeout=12.0) as client:
            resp = client.get(url, headers=req_headers)
        if resp.status_code == 200:
            payload = resp.json()
            db.external_cache.replace_one(
                {"_id": url},
                {"_id": url, "payload": payload, "fetched_at": now},
                upsert=True,
            )
            return payload
        if resp.status_code == 404:
            return None
    except Exception:
        pass  # network down — fall through to stale cache

    return cached.get("payload") if cached is not None else None


def tba(db: Database, path: str, ttl: Optional[int] = None) -> Optional[Any]:
    return _get_json(
        db,
        f"{settings.tba_base}{path}",
        headers={"accept": "application/json", "X-TBA-Auth-Key": settings.tba_key},
        ttl=ttl,
    )


def statbotics(db: Database, path: str, ttl: Optional[int] = None) -> Optional[Any]:
    return _get_json(
        db,
        f"{settings.statbotics_base}{path}",
        headers={"accept": "application/json"},
        ttl=ttl,
    )


# --------------------------------------------------------------------------- #
# Higher level helpers                                                         #
# --------------------------------------------------------------------------- #
def sync_event_matches(db: Database, event_key: str) -> list[MatchView]:
    """Pull the match schedule for an event into the matches collection.

    Uses the full ``/matches`` endpoint (not ``/simple``) so we also capture
    the YouTube match videos for the Film tab.
    """
    repo = HazeHubRepository(db)
    sync_event_info(db, event_key)

    data = tba(db, f"/event/{event_key}/matches")
    out: list[MatchView] = []
    if not data:
        return out

    existing = {d["_id"]: d for d in db.matches.find({"event_key": event_key})}
    for m in data:
        alliances = m.get("alliances", {}) or {}
        red = alliances.get("red", {}) or {}
        blue = alliances.get("blue", {}) or {}
        red_teams = [int(t[3:]) for t in red.get("team_keys", []) if t.startswith("frc")]
        blue_teams = [int(t[3:]) for t in blue.get("team_keys", []) if t.startswith("frc")]
        if not red_teams or not blue_teams:
            continue

        def _score(raw: Any) -> Optional[int]:
            return int(raw) if raw is not None and int(raw) >= 0 else None

        red_score, blue_score = _score(red.get("score")), _score(blue.get("score"))
        winner = None
        if red_score is not None and blue_score is not None:
            if red_score > blue_score:
                winner = "red"
            elif blue_score > red_score:
                winner = "blue"
            else:
                winner = "tie"

        prev = existing.get(m["key"], {})
        youtube_key = prev.get("youtube_key") or ""
        if not youtube_key:
            for v in m.get("videos") or []:
                if v.get("type") == "youtube" and v.get("key"):
                    youtube_key = v["key"]
                    break

        try:
            document = MatchDocument(
                _id=m["key"],
                event_key=event_key,
                comp_level=m.get("comp_level", "qm"),
                set_number=int(m.get("set_number") or 1),
                match_num=int(m.get("match_number") or 0),
                alliances={
                    "red": {"teams": red_teams, "score": red_score},
                    "blue": {"teams": blue_teams, "score": blue_score},
                },
                winner=winner,
                predicted_time=m.get("predicted_time") or m.get("time"),
                # Preserve app state across schedule refreshes.
                betting_locked=bool(prev.get("betting_locked", False)),
                youtube_key=youtube_key,
                film_summary=prev.get("film_summary") or "",
                film_events=prev.get("film_events") or [],
            )
            out.append(MatchView(repo.upsert_match(document)))
        except (ValueError, RepositoryError):
            # One malformed TBA row (odd comp level, surrogate keys, …) must
            # not sink the whole schedule sync.
            continue
    return out


def sync_event_info(db: Database, event_key: str) -> None:
    """Upsert the events row (name + dates from TBA, best effort)."""
    info = tba(db, f"/event/{event_key}") or {}

    def _date(value: Any) -> Optional[date]:
        try:
            return date.fromisoformat(value)
        except (TypeError, ValueError):
            return None

    try:
        HazeHubRepository(db).upsert_event(
            EventDocument(
                _id=event_key,
                name=(info.get("name") or None),
                start_date=_date(info.get("start_date")),
                end_date=_date(info.get("end_date")),
            )
        )
    except (ValueError, RepositoryError):
        pass


def sync_team(
    db: Database, team_number: int, season: Optional[int] = None
) -> Optional[TeamCacheDocument]:
    """Fetch profile, media (avatar + robot photos) and EPA for one team."""
    season = season or settings.season
    prev = db.team_cache.find_one({"_id": int(team_number)}) or {}

    fields: dict[str, Any] = {
        "nickname": prev.get("nickname") or "",
        "name": prev.get("name") or "",
        "city": prev.get("city") or "",
        "state": prev.get("state") or "",
        "country": prev.get("country") or "",
        "rookie_year": prev.get("rookie_year"),
        "avatar": prev.get("avatar") or "",
        "photos": prev.get("photos") or [],
        "epa": prev.get("epa"),
    }

    info = tba(db, f"/team/{team_key(team_number)}", ttl=86400)
    if info:
        fields["nickname"] = info.get("nickname") or fields["nickname"]
        fields["name"] = info.get("name") or fields["name"]
        fields["city"] = info.get("city") or ""
        fields["state"] = info.get("state_prov") or ""
        fields["country"] = info.get("country") or ""
        fields["rookie_year"] = info.get("rookie_year")

    media = tba(db, f"/team/{team_key(team_number)}/media/{season}", ttl=86400)
    if media:
        photos: list[str] = []
        for item in media:
            mtype = item.get("type")
            details = item.get("details") or {}
            if mtype == "avatar" and details.get("base64Image"):
                fields["avatar"] = f"data:image/png;base64,{details['base64Image']}"
            else:
                url = item.get("direct_url") or item.get("view_url")
                if url and mtype in ("imgur", "instagram-image", "cdphotothread", "grabcad"):
                    photos.append(url)
        if photos:
            fields["photos"] = photos[:8]

    sb = statbotics(db, f"/team_year/{team_number}/{season}", ttl=3600)
    if sb:
        # Statbotics has shipped two shapes for this field:
        #   v3 (2025):  epa.total_points = {"mean": 55.1, ...}
        #   v3 (2026):  epa.total_points = 112.62
        raw = (sb.get("epa") or {}).get("total_points")
        if isinstance(raw, dict):
            fields["epa"] = raw.get("mean")
        elif isinstance(raw, (int, float)):
            fields["epa"] = float(raw)
        else:
            fields["epa"] = None

    try:
        document = TeamCacheDocument(_id=int(team_number), **fields)
        HazeHubRepository(db).upsert_team_cache(document)
        return document
    except (ValueError, RepositoryError):
        return None


def match_win_prob(db: Database, match_key: str) -> Optional[float]:
    """Statbotics predicted probability that **red** wins ``match_key``."""
    sb = statbotics(db, f"/match/{match_key}", ttl=600)
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
