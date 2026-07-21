"""Cloud dashboard + reconciliation — the admin System Health panel.

The direct-to-cloud design means this API can only see what devices have
managed to sync. So beyond database health, the panel focuses on the two
questions that matter at an event:

1. **Reconciliation** — for every played match, compare the schedule (six
   robots) against received submissions: missing, duplicates, wrong-team.
2. **Staleness** — scouts/devices that have not checked in recently may still
   hold unsynchronized records in IndexedDB.
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlmodel import Session, func, select

from ..auth import require_admin
from ..config import settings
from ..database import engine, get_session
from ..models import MatchRecord, Scouter, ScoutEntry
from ..store import get_setting

router = APIRouter(prefix="/api/admin", tags=["system"])

STALE_AFTER_SECONDS = 15 * 60


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _db_status() -> dict:
    dialect = "postgres" if "postgres" in settings.DATABASE_URL else "sqlite"
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        reachable = True
        error = ""
    except Exception as exc:  # noqa: BLE001
        reachable = False
        error = f"{type(exc).__name__}: {exc}"
    out = {
        "engine": dialect,
        "reachable": reachable,
        "configured": settings.DATABASE_CONFIGURED,
    }
    if error:
        out["error"] = error
    if settings.IS_VERCEL and not settings.DATABASE_CONFIGURED:
        out["warning"] = (
            "DATABASE_URL is not set — this deployment is using per-instance "
            "SQLite scratch space and WILL NOT retain data. Point DATABASE_URL "
            "at a cloud PostgreSQL (Neon / Azure Database for PostgreSQL)."
        )
    return out


def _reconciliation(session: Session, event_key: str, current_match: int) -> dict:
    """Schedule vs received submissions for played qual matches."""
    if not event_key or current_match <= 0:
        return {
            "checked_matches": 0,
            "missing": {"count": 0, "matches": []},
            "duplicates": {"count": 0, "items": []},
            "wrong_team": {"count": 0, "items": []},
            "by_match": [],
        }

    matches = {
        int(m.match_number): m
        for m in session.exec(
            select(MatchRecord).where(
                MatchRecord.event_key == event_key,
                MatchRecord.comp_level == "qm",
            )
        ).all()
        if 0 < m.match_number <= current_match
    }
    entries = session.exec(
        select(ScoutEntry).where(
            ScoutEntry.event_key == event_key,
            ScoutEntry.comp_level == "qm",
        )
    ).all()
    entries = [e for e in entries if e.match_number in matches]

    by_match: dict[int, list[ScoutEntry]] = {n: [] for n in matches}
    for e in entries:
        by_match[e.match_number].append(e)

    missing = [n for n, group in sorted(by_match.items()) if not group]

    duplicates = []
    wrong_team = []
    for n, group in sorted(by_match.items()):
        match = matches[n]
        on_field = set(match.red) | set(match.blue)
        seen: dict[int, int] = {}
        for e in group:
            seen[e.team_number] = seen.get(e.team_number, 0) + 1
            if on_field and e.team_number not in on_field:
                wrong_team.append(
                    {"match": n, "team": e.team_number, "scout_id": e.scout_id}
                )
        for team, count in seen.items():
            if count > 1:
                duplicates.append({"match": n, "team": team, "count": count})

    per_match = [
        {"match": n, "submissions": len(group), "teams_covered": len({e.team_number for e in group})}
        for n, group in sorted(by_match.items())
    ]

    return {
        "checked_matches": len(matches),
        "missing": {"count": len(missing), "matches": missing[:40]},
        "duplicates": {"count": len(duplicates), "items": duplicates[:20]},
        "wrong_team": {"count": len(wrong_team), "items": wrong_team[:20]},
        "by_match": per_match[-25:],
    }


def _scout_activity(session: Session) -> list[dict]:
    """Per-scout check-in freshness. A silent scout may hold unsynced records."""
    now = _now()
    out = []
    for s in session.exec(select(Scouter)).all():
        last_seen = _aware(s.last_seen) if s.last_seen else None
        age = (now - last_seen).total_seconds() if last_seen else None
        out.append(
            {
                "scout_id": s.scout_id,
                "display_name": s.display_name or s.scout_id,
                "matches_scouted": s.matches_scouted,
                "last_seen": last_seen.isoformat() if last_seen else None,
                "seconds_since_seen": round(age, 0) if age is not None else None,
                "potentially_stale": bool(age is not None and age > STALE_AFTER_SECONDS),
            }
        )
    out.sort(key=lambda r: (r["seconds_since_seen"] is None, -(r["seconds_since_seen"] or 0)))
    return out


def _network_status() -> dict:
    """Cellular/gateway stats from the UniFi/gateway API, if configured."""
    fields = {"carrier": None, "signal_quality": None, "packet_loss": None}
    if not settings.GATEWAY_STATS_URL:
        return {"available": False, "reason": "HAZEHUB_GATEWAY_STATS_URL not set", **fields}
    try:
        with httpx.Client(timeout=4.0) as client:
            data = client.get(settings.GATEWAY_STATS_URL).json()
        return {
            "available": True,
            "carrier": data.get("carrier"),
            "signal_quality": data.get("signal_quality") or data.get("rssi"),
            "packet_loss": data.get("packet_loss"),
        }
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}", **fields}


@router.get("/system-health")
def system_health(
    session: Session = Depends(get_session),
    _: Scouter = Depends(require_admin),
) -> dict:
    event_key = get_setting(session, "current_event")
    current_match = int(get_setting(session, "current_match") or 0)
    total_entries = int(session.exec(select(func.count()).select_from(ScoutEntry)).one())

    return {
        "generated_at": _now().isoformat(),
        "environment": "vercel" if settings.IS_VERCEL else ("azure" if settings.IS_AZURE else "local"),
        "event": {"current_event": event_key, "current_match": current_match},
        "database": _db_status(),
        "records": {"scouting_total": total_entries},
        "reconciliation": _reconciliation(session, event_key, current_match),
        "scouts": _scout_activity(session),
        "network": _network_status(),
    }
