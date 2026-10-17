"""Freeze a finished event into one durable document.

The raw scouting is never deleted, but only the *current* event is mirrored
into RAM (see ``schema.EVENT_SCOPED_CACHED``): that is what keeps a season of
data off the free tier's read budget. The cost is that the moment an admin
switches to the next event, last event's records stop being readable without a
bulk re-read of the whole collection.

So when an event ends, everything worth keeping about it is rolled up into a
single ``event_archives`` document: per-team aggregates, the final pick order,
the totals, and the game it was played under. One read gets you the whole
event back, which is what makes "how did 254 look at their last regional"
answerable in the pit at the next one.

Archiving is idempotent. Running it twice recomputes and overwrites, so an
event can be archived mid-competition for a checkpoint and again at the end.
"""
from __future__ import annotations

import logging
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any

from . import repo
from .analytics import data_analysis, data_picklist, event_teams, rank_teams, team_summary
from .cache import doc_bytes
from . import schema
from . import seasons
from .models import EventArchive, EventArchiveChunk

log = logging.getLogger("hazehub.archive")

DETAIL_FIELDS = ("event", "matches", "scouting", "pit_raw", "picklists_raw", "bets", "team_cache", "analytics")
LIST_DETAIL_FIELDS = {"matches", "scouting", "pit_raw", "picklists_raw", "bets", "team_cache"}
CHUNK_TARGET_BYTES = schema.MAX_DOC_BYTES - 40_000


def _final_picklists(event_key: str) -> list[dict[str, Any]]:
    """The pick orders the team actually settled on, master and final."""
    out = []
    for row in repo.picklists(event_key):
        if not row.is_master or not row.items:
            continue
        out.append(
            {
                "owner_id": row.owner_id,
                "name": row.name,
                "pick_round": row.pick_round,
                "items": row.items,
            }
        )
    return out


def _analytics_snapshot(event_key: str) -> dict[str, Any]:
    try:
        return {
            "rankings": {
                "avg_points": rank_teams(event_key, "avg_points"),
                "consistency": rank_teams(event_key, "consistency"),
                "climb_rate": rank_teams(event_key, "climb_rate"),
                "defense_rate": rank_teams(event_key, "defense_rate"),
            },
            "data_analysis": data_analysis(event_key),
            "data_picklist": data_picklist(event_key),
        }
    except Exception as exc:  # noqa: BLE001
        log.warning("could not include analytics snapshot for %s: %s", event_key, exc)
        return {}


def build_archive(event_key: str, name: str | None = None) -> EventArchive:
    """Roll an event up. Reads only what is already in memory."""
    event_key = (event_key or "").strip()
    if not event_key:
        raise ValueError("An event key is required to archive")

    entries = repo.scouting_for_event(event_key)
    matches = repo.matches_for_event(event_key)
    pits = repo.pits_for_event(event_key)
    picklists = repo.picklists(event_key)
    bets = repo.bets(event_key)
    event = repo.event(event_key)

    # Per-team aggregates are the point of the archive: they are what somebody
    # looks up next season, and they are two orders of magnitude smaller than
    # the submissions they came from.
    teams = {}
    for team in event_teams(event_key):
        summary = dict(team_summary(event_key, team))
        # Two things are dropped, both for size. A Firestore document
        # is capped at 1 MiB and a champs-sized event is 60+ teams, so the
        # archive has to stay lean or it stops being writable at exactly the
        # event you most want to keep.
        #   match_points: a per-match series nobody reads off an archive
        #   avatar: a base64 PNG that already lives in team_cache, which is
        #           global and outlives the event anyway
        summary.pop("match_points", None)
        summary.pop("avatar", None)
        teams[str(team)] = summary

    team_cache = []
    for team in event_teams(event_key):
        cached = repo.team(team)
        if cached:
            row = cached.to_doc()
            # Avatars can be tens of KiB and are not needed for historical stats.
            row.pop("avatar", None)
            row.pop("photos", None)
            team_cache.append(row)

    pit_rows = [
        {
            "team_number": p.team_number,
            "archetype": p.archetype,
            "drivetrain": p.drivetrain,
            "weight_lbs": p.weight_lbs,
            "can_climb": p.can_climb,
            "notes": p.notes,
        }
        for p in pits
    ]

    played = [m for m in matches if m.winner]
    # The season the event actually ran under, taken from what was scouted
    # rather than from whatever season is current when the archive is built.
    season_id = next((e.season_id for e in entries if e.season_id), seasons.current_season_id())
    game = seasons.definition(season_id)

    return EventArchive(
        event_key=event_key,
        name=(name or (event.name if event else "") or event_key).strip() or event_key,
        season=game.year,
        game_name=game.name,
        archived_at=datetime.now(timezone.utc),
        counts={
            "matches": len(matches),
            "matches_played": len(played),
            "scouting_entries": len(entries),
            "pit_reports": len(pits),
            "teams": len(teams),
            "picklists": len(picklists),
            "bets": len(bets),
        },
        teams=teams,
        pit=pit_rows,
        picklists=_final_picklists(event_key),
        event=event.to_doc() if event else {"event_key": event_key},
        matches=[m.to_doc() for m in matches],
        scouting=[e.to_doc() for e in entries],
        pit_raw=[p.to_doc() for p in pits],
        picklists_raw=[p.to_doc() for p in picklists],
        bets=[b.to_doc() for b in bets],
        team_cache=team_cache,
        analytics=_analytics_snapshot(event_key),
    )


def _chunk_doc_id(event_key: str, kind: str, index: int) -> str:
    return f"{event_key}__{kind}__{index:04d}"


def _make_chunk(event_key: str, kind: str, index: int, data: Any) -> EventArchiveChunk:
    return EventArchiveChunk(
        archive_id=_chunk_doc_id(event_key, kind, index),
        event_key=event_key,
        kind=kind,
        index=index,
        data=data,
    )


def _chunk_list(event_key: str, kind: str, rows: list[dict[str, Any]]) -> list[EventArchiveChunk]:
    chunks: list[EventArchiveChunk] = []
    current: list[dict[str, Any]] = []
    index = 0
    for row in rows:
        candidate = [*current, row]
        chunk = _make_chunk(event_key, kind, index, candidate)
        if current and doc_bytes(chunk.to_doc()) > CHUNK_TARGET_BYTES:
            chunks.append(_make_chunk(event_key, kind, index, current))
            index += 1
            current = [row]
        else:
            current = candidate
    if current:
        chunks.append(_make_chunk(event_key, kind, index, current))
    return chunks


def _split_for_storage(archive: EventArchive) -> tuple[EventArchive, list[EventArchiveChunk]]:
    """Keep the archive list document small and put full detail in chunks."""
    summary = replace(archive)
    chunks: list[EventArchiveChunk] = []
    for kind in DETAIL_FIELDS:
        value = getattr(archive, kind)
        if not value:
            continue
        if kind in LIST_DETAIL_FIELDS:
            chunks.extend(_chunk_list(archive.event_key, kind, list(value or [])))
            setattr(summary, kind, [])
        else:
            chunk = _make_chunk(archive.event_key, kind, 0, value)
            chunks.append(chunk)
            setattr(summary, kind, {})
    summary.chunk_ids = [chunk.archive_id for chunk in chunks]
    return summary, chunks


def archive_event(event_key: str, name: str | None = None) -> EventArchive:
    """Build and store the archive for one event."""
    archive = build_archive(event_key, name)
    summary, chunks = _split_for_storage(archive)
    repo.save_archive(summary, chunks)
    archive.chunk_ids = summary.chunk_ids
    log.info(
        "archived %s: %d teams, %d entries",
        event_key, archive.counts.get("teams", 0), archive.counts.get("scouting_entries", 0),
    )
    return archive


def archive_if_worthwhile(event_key: str) -> EventArchive | None:
    """Archive an event on the way out, unless there is nothing to keep.

    Called when an admin switches to a new event, which is the moment the
    outgoing one stops being readable from the cache. An event with no
    scouting was a mistyped key or a dry run, and writing a document for it
    would just be noise in the archive list.
    """
    event_key = (event_key or "").strip()
    if not event_key:
        return None
    if not repo.scouting_for_event(event_key):
        return None
    try:
        return archive_event(event_key)
    except Exception as exc:  # noqa: BLE001
        # Never block an event change on the archive: the raw documents are
        # still in the datastore either way, and the admin is standing at a
        # competition waiting for the new schedule.
        log.warning("could not archive %s: %s", event_key, exc)
        return None
