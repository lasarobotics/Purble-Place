"""Small authenticated page snapshots; no per-team upstream fan-out."""
import asyncio
import hashlib
import json
from uuid import uuid4
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from .. import analytics, external, repo, schema
from ..auth import current_scouter
from ..models import Scouter

router = APIRouter(prefix="/api/pages", tags=["pages"])
BOOT = uuid4().hex
DEPS = (*analytics._DEPS, schema.SCOUTERS, schema.PICKLISTS, schema.PIT_SCOUTING)


def snapshot(request, user, key, value):
    revision = (BOOT, repo.store.revision(*DEPS), external._revision, user.scout_id, user.role)
    tag = '"' + hashlib.sha256((key + repr(revision)).encode()).hexdigest()[:32] + '"'
    headers = {"ETag": tag, "Cache-Control": "private, no-cache", "Vary": "Authorization, Cookie"}
    if tag in [t.strip().removeprefix("W/") for t in request.headers.get("If-None-Match", "").split(",")]:
        return Response(status_code=304, headers=headers)
    return JSONResponse(value() if callable(value) else value, headers=headers)


@router.get("/analysis")
def analysis(request: Request, event: str | None = None, user: Scouter = Depends(current_scouter)):
    event = repo.resolve_event(event)
    def build():
        summaries = analytics.all_summaries(event)
        return {"event": event, "teams": [{**summaries.get(row["team"], {}), **row} for row in analytics.data_analysis(event)],
                "metrics": [{"key": k, "label": v} for k, v in analytics.RANK_METRICS.items()]}
    return snapshot(request, user, "analysis:" + event, build)


async def source_data(event):
    calls = {
        "rankings": external.tba(f"/event/{event}/rankings", ttl=60),
        "alliances": external.tba(f"/event/{event}/alliances", ttl=120),
        "event_info": external.tba(f"/event/{event}", ttl=3600),
        "official_matches": external.tba(f"/event/{event}/matches", ttl=60),
        "advancement": external.tba(f"/event/{event}/playoff_advancement", ttl=60),
        "oprs": external.tba(f"/event/{event}/oprs", ttl=300),
        "statbotics_teams": external.statbotics(f"/team_events?event={event}&limit=1000", ttl=300),
        "statbotics_matches": external.statbotics(f"/matches?event={event}&limit=1000", ttl=60),
        "match13": external.match13_event_ratings(event),
    }
    # At most four upstream categories in flight; failures remain source-specific.
    gate = asyncio.Semaphore(4)
    async def get(coro):
        async with gate:
            try: return await coro
            except Exception: return None
    values = await asyncio.gather(*(get(c) for c in calls.values()))
    return {"event": event, **dict(zip(calls, values)),
            "match13_simulation": {"available": False, "reason": "A documented simulation response has not yet been verified; no projections are fabricated."}}


@router.get("/external")
async def sources(request: Request, event: str | None = None, user: Scouter = Depends(current_scouter)):
    event = repo.resolve_event(event)
    value = await source_data(event) if event else {"event": ""}
    return snapshot(request, user, "external:" + event, value)
