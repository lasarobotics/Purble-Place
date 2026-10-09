"""Cloud dashboard + reconciliation: the admin System Health panel.

The direct-to-cloud design means this API can only see what devices have
managed to sync. So beyond datastore health, the panel focuses on the two
questions that matter at an event:

1. **Reconciliation**: for every played match, compare the schedule (six
   robots) against received submissions: missing, duplicates, wrong-team.
2. **Staleness**: scouts/devices that have not checked in recently may still
   hold unsynchronized records in IndexedDB.

Plus, since the migration to Firestore, a third: **quota**. The panel reports
the day's document operations against the free-tier allowance so a problem is
visible hours before it becomes an outage.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import repo
from ..auth import current_scouter, require_admin
from ..config import settings
from ..external import cache_stats as external_cache_stats
from ..firestore_db import guard
from ..firestore_db import status as firestore_status
from ..models import Device, NetworkStatus, OutboxRecord, Scouter, ScoutEntry
from ..realtime import buffered_count, hub

router = APIRouter(prefix="/api/admin", tags=["system"])

STALE_AFTER_SECONDS = 15 * 60


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _reconciliation(event_key: str, current_match: int) -> dict:
    """Schedule vs received submissions for played qual matches.

    Reported per *slot*, not per match. Six robots play every match and each
    one is somebody's assignment, so "Q12 is missing" is not actionable while
    "Q12 red 2 (team 254)" tells the strategy lead exactly which chair was
    empty and who to ask. A match with five of six reports used to look
    completely clean here.

    Two reports on the same robot are *not* a fault. Every submission is kept: nothing here or anywhere else deletes one: and double-scouting is what
    feeds the Consensus Radar, so they are counted separately as coverage
    rather than mixed into the findings total.
    """
    empty = {
        "checked_matches": 0,
        "missing": {"count": 0, "matches": [], "slots": []},
        "duplicates": {"count": 0, "items": []},
        "double_scouted": {"count": 0, "items": []},
        "wrong_team": {"count": 0, "items": []},
        "by_match": [],
    }
    if not event_key or current_match <= 0:
        return empty

    matches = {
        int(m.match_number): m
        for m in repo.matches_for_event(event_key)
        if m.comp_level == "qm" and 0 < m.match_number <= current_match
    }

    by_match: dict[int, list[ScoutEntry]] = {n: [] for n in matches}
    for e in repo.scouting_for_event(event_key):
        if e.comp_level == "qm" and e.match_number in by_match:
            by_match[e.match_number].append(e)

    missing_slots: list[dict] = []
    missing_matches: list[int] = []
    double_scouted = []
    wrong_team = []

    for n, group in sorted(by_match.items()):
        match = matches[n]
        # A no-show report still means somebody was in that chair watching,
        # so it counts as covered.
        covered = {e.team_number for e in group}
        on_field = set(match.red) | set(match.blue)

        # Walk the schedule so every gap carries its driver station, which is
        # how scouting assignments are handed out in the first place.
        for alliance, teams in (("red", match.red), ("blue", match.blue)):
            for station, team in enumerate(teams, 1):
                if not team or team in covered:
                    continue
                missing_slots.append(
                    {"match": n, "alliance": alliance, "station": station, "team": team}
                )
        if not group:
            missing_matches.append(n)

        seen: dict[int, int] = {}
        for e in group:
            seen[e.team_number] = seen.get(e.team_number, 0) + 1
            if on_field and e.team_number not in on_field:
                wrong_team.append(
                    {
                        "match": n,
                        "team": e.team_number,
                        "scout_id": e.scout_id,
                        "alliance": e.alliance,
                        "station": e.station,
                    }
                )
        for team, count in seen.items():
            if count > 1:
                double_scouted.append({"match": n, "team": team, "count": count})

    per_match = [
        {"match": n, "submissions": len(group), "teams_covered": len({e.team_number for e in group})}
        for n, group in sorted(by_match.items())
    ]

    return {
        "checked_matches": len(matches),
        "missing": {
            # The count is now slots, not whole matches, so a match scouted by
            # five people out of six still shows up as one finding.
            "count": len(missing_slots),
            "matches": missing_matches[:40],
            "slots": missing_slots[:60],
        },
        # Kept under the old key so an older client still renders, but these
        # are reports we deliberately keep, not records to clean up.
        "duplicates": {"count": len(double_scouted), "items": double_scouted[:20]},
        "double_scouted": {"count": len(double_scouted), "items": double_scouted[:20]},
        "wrong_team": {"count": len(wrong_team), "items": wrong_team[:20]},
        "by_match": per_match[-25:],
    }


def _scout_activity() -> list[dict]:
    """Per-scout check-in freshness. A silent scout may hold unsynced records.

    ``last_seen`` comes from the in-memory presence map, which is updated on
    every authenticated request and persisted to Firestore at most hourly: live freshness without a write per request.
    """
    now = _now()
    out = []
    for s in repo.scouters():
        seen = repo.last_seen(s)
        last_seen = _aware(seen) if seen else None
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


def _device_activity() -> list[dict]:
    now = _now()
    out = []
    for d in repo.devices():
        seen = _aware(d.last_seen_at) if d.last_seen_at else None
        age = (now - seen).total_seconds() if seen else None
        out.append(
            {
                "device_id": d.device_id,
                "role": d.role,
                "vlan_port": d.vlan_port,
                "battery_pct": d.battery_pct,
                "unsynced_count": d.unsynced_count,
                "scout_id": d.scout_id,
                "last_seen_at": seen.isoformat() if seen else None,
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
        out = {
            "available": True,
            "carrier": data.get("carrier"),
            "signal_quality": data.get("signal_quality") or data.get("rssi"),
            "packet_loss": data.get("packet_loss"),
        }
        # Snapshot to the network_status collection, throttled to 1 per 5 min.
        repo.record_network_status(
            NetworkStatus(
                active_carrier=out["carrier"] or "",
                signal_quality=out["signal_quality"],
                packet_loss=out["packet_loss"],
                firestore_status="reachable" if repo.cache_stats().get("ready") else "degraded",
                unsynced_count=sum(d.unsynced_count for d in repo.devices()),
            )
        )
        return out
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}", **fields}


@router.get("/system-health")
def system_health(_: Scouter = Depends(require_admin)) -> dict:
    event_key = repo.current_event()
    current_match = int(repo.setting("current_match") or 0)

    return {
        "generated_at": _now().isoformat(),
        "environment": settings.ENVIRONMENT,
        "event": {"current_event": event_key, "current_match": current_match},
        "database": firestore_status(),
        "quota": guard.snapshot(),
        "cache": repo.cache_stats(),
        "external_cache": external_cache_stats(),
        "realtime": {
            "websocket_clients": hub.client_count(),
            "buffered_events": buffered_count(),
        },
        "records": {"scouting_total": repo.scouting_total()},
        "reconciliation": _reconciliation(event_key, current_match),
        "scouts": _scout_activity(),
        "devices": _device_activity(),
        "network": _network_status(),
    }


# --------------------------------------------------------------------------- #
# Device check-in                                                              #
# --------------------------------------------------------------------------- #
class DeviceIn(BaseModel):
    device_id: str
    role: str = "scouting"
    vlan_port: Optional[int] = None
    battery_pct: Optional[int] = None
    unsynced_count: int = 0


@router.post("/device-checkin")
def device_checkin(
    body: DeviceIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    """Record a device heartbeat (battery, VLAN port, queue depth).

    Throttled to one Firestore write per device per two minutes: devices can
    call this as often as they like.
    """
    repo.record_device(
        Device(
            device_id=body.device_id,
            role=body.role,
            vlan_port=body.vlan_port,
            battery_pct=body.battery_pct,
            unsynced_count=body.unsynced_count,
            scout_id=scouter.scout_id,
        )
    )
    return {"ok": True}


class OutboxFailureIn(BaseModel):
    submission_id: str
    device_id: str = ""
    attempt_count: int = 0
    error: str = ""


@router.post("/outbox-failure")
def report_outbox_failure(
    body: OutboxFailureIn,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """Record a submission a device gave up on, so it can be chased later.

    Only terminal failures are stored: mirroring the live queue would cost a
    write per state transition per submission for data that is already on the
    device.
    """
    repo.record_outbox_failure(
        OutboxRecord(
            submission_id=body.submission_id,
            device_id=body.device_id,
            attempt_count=body.attempt_count,
            error=body.error,
            status="failed",
            last_attempt_at=_now(),
        )
    )
    return {"ok": True}
