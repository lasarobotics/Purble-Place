"""MegaScout System Health — the admin diagnostics panel.

Surfaces exactly the signals the Strategy Router design calls out for debugging
at an event: database status, how far the outbox is behind Azure, the oldest
record still not synced (with its match #), matches that look under-scouted, the
sync worker's liveness, and (when a gateway stats API is configured) cellular
carrier / signal / packet-loss.
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
from ..models import MatchRecord, Scouter, ScoutEntry, WorkerHeartbeat
from ..outbox import oldest_unsynced, outbox_stats
from ..store import get_setting

router = APIRouter(prefix="/api/admin", tags=["system"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _db_status() -> dict:
    dialect = "postgres" if "postgres" in settings.DATABASE_URL else "sqlite"
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"engine": dialect, "reachable": True}
    except Exception as exc:  # noqa: BLE001
        return {"engine": dialect, "reachable": False, "error": f"{type(exc).__name__}: {exc}"}


def _missing_submissions(session: Session, event_key: str, current_match: int) -> dict:
    """Qual matches that have already been played but have no scouting yet.

    "Played" = match_number <= the current on-field match. These are the gaps a
    strategy lead needs to chase down before they compound.
    """
    if not event_key or current_match <= 0:
        return {"count": 0, "matches": []}

    scouted = {
        int(m)
        for m in session.exec(
            select(ScoutEntry.match_number).where(
                ScoutEntry.event_key == event_key,
                ScoutEntry.comp_level == "qm",
            )
        ).all()
    }
    scheduled = sorted(
        int(m.match_number)
        for m in session.exec(
            select(MatchRecord).where(
                MatchRecord.event_key == event_key,
                MatchRecord.comp_level == "qm",
            )
        ).all()
        if 0 < m.match_number <= current_match
    )
    missing = [m for m in scheduled if m not in scouted]
    return {"count": len(missing), "matches": missing[:40]}


def _worker_status(session: Session) -> dict:
    hb = session.get(WorkerHeartbeat, "azure_sync")
    if hb is None:
        return {
            "running": False,
            "detail": "no heartbeat yet — start `python -m app.sync_worker`",
            "cloud_sync_enabled": settings.CLOUD_SYNC_ENABLED,
        }
    beat = hb.last_beat
    if beat.tzinfo is None:
        beat = beat.replace(tzinfo=timezone.utc)
    age = (_now() - beat).total_seconds()
    return {
        # Healthy if we heard from it within ~4 poll intervals.
        "running": age <= max(30.0, settings.SYNC_INTERVAL_SECONDS * 4),
        "last_beat": beat.isoformat(),
        "seconds_since_beat": round(age, 1),
        "last_synced": hb.last_synced,
        "cloud_reachable": hb.cloud_reachable,
        "last_error": hb.last_error,
        "cloud_sync_enabled": settings.CLOUD_SYNC_ENABLED,
    }


def _network_status() -> dict:
    """Cellular/gateway stats from the UniFi/gateway API, if configured.

    In dev (and on any box without the physical gateway API) this is honestly
    reported as unavailable rather than invented.
    """
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

    stats = outbox_stats(session)
    oldest = oldest_unsynced(session)
    oldest_payload = None
    if oldest is not None:
        created = oldest.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        oldest_payload = {
            "submission_id": oldest.submission_id,
            "event_key": oldest.event_key,
            "match_number": oldest.match_number,
            "team_number": oldest.team_number,
            "scout_id": oldest.scout_id,
            "status": oldest.status,
            "attempts": oldest.attempts,
            "queued_at": created.isoformat(),
            "age_seconds": round((_now() - created).total_seconds(), 1),
            "last_error": oldest.last_error,
        }

    total_entries = int(session.exec(select(func.count()).select_from(ScoutEntry)).one())

    return {
        "generated_at": _now().isoformat(),
        "megascout": settings.IS_MEGASCOUT,
        "event": {"current_event": event_key, "current_match": current_match},
        "database": _db_status(),
        "records": {"scouting_total": total_entries},
        "sync": {
            **stats,
            "cloud_sync_enabled": settings.CLOUD_SYNC_ENABLED,
            "oldest_unsynced": oldest_payload,
        },
        "worker": _worker_status(session),
        "missing_submissions": _missing_submissions(session, event_key, current_match),
        "network": _network_status(),
    }
