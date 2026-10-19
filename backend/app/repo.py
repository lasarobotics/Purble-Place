"""Repository layer: every query and mutation HazeHub performs.

This replaces the SQLModel ``Session`` that used to be threaded through every
router. Reads are served from :mod:`cache` (RAM, zero Firestore cost); writes
go through the cache's write-through path so the mirror can never drift.

Grouped views (``scouting_for_team``, ``matches_by_number``, ...) are rebuilt
lazily and memoised against the owning collection's revision counter, so a
page that asks for one team's reports does not scan every submission at the
event on every request: it scans once per change.
"""
from __future__ import annotations

import logging
import os
import hashlib
import threading
import time
from concurrent.futures import Future
from datetime import datetime, timezone
from typing import Any, Callable, Optional, TypeVar

from . import schema
from .cache import WriteTooLarge, store
from .models import (
    Bet,
    Device,
    Event,
    EventArchive,
    EventArchiveChunk,
    Form,
    FormRevision,
    Season,
    SeasonRevision,
    MatchRecord,
    NetworkStatus,
    OutboxRecord,
    Picklist,
    PitEntry, PitPhoto,
    Scouter,
    ScoutEntry,
    TeamCache,
    next_seq_id,
)

log = logging.getLogger("hazehub.repo")

T = TypeVar("T")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Revision-keyed memoisation                                                   #
# --------------------------------------------------------------------------- #
_memo_lock = threading.RLock()
_memo: dict[str, tuple[tuple[int, ...], Any]] = {}
_memo_flights: dict[tuple, Future] = {}
_memo_epoch = 0
MAX_MEMO_ENTRIES = 2048


def memoized(key: str, collections: tuple[str, ...], build: Callable[[], T]) -> T:
    """Cache ``build()`` until any of ``collections`` changes.

    Used for the derived indexes below and by ``analytics`` for the expensive
    per-event aggregations. Cheap to check (a tuple compare), and correctness
    comes for free because every mutation bumps a revision counter.
    """
    stamp = store.revision(*collections)
    with _memo_lock:
        hit = _memo.get(key)
        if hit is not None and hit[0] == stamp:
            return hit[1]
        epoch = _memo_epoch
        flight_key = (key, stamp, epoch)
        flight = _memo_flights.get(flight_key)
        owner = flight is None
        if owner:
            flight = Future()
            _memo_flights[flight_key] = flight
    if not owner:
        return flight.result()
    try:
        value = build()
        with _memo_lock:
            if epoch == _memo_epoch and stamp == store.revision(*collections):
                if len(_memo) >= MAX_MEMO_ENTRIES and key not in _memo:
                    _memo.pop(next(iter(_memo)))
                _memo[key] = (stamp, value)
        flight.set_result(value)
        return value
    except BaseException as exc:
        flight.set_exception(exc)
        raise
    finally:
        with _memo_lock:
            _memo_flights.pop(flight_key, None)


def invalidate_memo() -> None:
    global _memo_epoch
    with _memo_lock:
        _memo_epoch += 1
        _memo.clear()


# --------------------------------------------------------------------------- #
# app_settings                                                                 #
# --------------------------------------------------------------------------- #
SETTING_DEFAULTS = {
    "current_event": "",
    "current_match": "0",
    "betting_enabled": "1",
    "post_comp_mode": "0",
}


def setting(key: str) -> str:
    value = store.setting_raw(key)
    return value if value != "" else SETTING_DEFAULTS.get(key, "")


def all_settings() -> dict[str, str]:
    out = dict(SETTING_DEFAULTS)
    out.update({k: v for k, v in store.all_settings_raw().items() if v != ""})
    return out


def set_setting(key: str, value: str) -> None:
    store.set_setting_raw(key, value)
    if key == "current_event":
        # Re-scope the event-filtered caches onto the new event.
        store.retarget_event(value)
        invalidate_memo()


def current_event() -> str:
    return setting("current_event").strip()


def resolve_event(event_key: Optional[str]) -> str:
    return (event_key or current_event()).strip()


# --------------------------------------------------------------------------- #
# scouters                                                                     #
# --------------------------------------------------------------------------- #
def scouter(scout_id: str) -> Optional[Scouter]:
    return store.get(schema.SCOUTERS, (scout_id or "").strip())


def scouters() -> list[Scouter]:
    return store.all(schema.SCOUTERS)


def save_scouter(s: Scouter, *, coalesce: bool = False) -> None:
    """Persist a scouter.

    ``coalesce=True`` is for counter bumps (``matches_scouted``): the change
    is visible immediately in memory and lands in Firestore within a couple of
    seconds, collapsing a burst of submissions into one write.
    """
    if coalesce:
        store.coalesce(s, delay_s=5.0)
    else:
        store.write(s)


def save_scouters(rows: list[Scouter]) -> int:
    return store.write_many(rows)


def next_s_number() -> int:
    highest = 0
    for s in scouters():
        if s.s_number:
            highest = max(highest, int(s.s_number))
    return highest + 1


# --- presence -------------------------------------------------------------- #
# ``last_seen`` is read constantly by the System Health panel but only needs
# to survive a restart, so it lives in memory and is persisted at most once an
# hour per scouter. Writing it on every request would cost ~8,600 writes/day
# for 60 scouts: nearly half the free daily allowance, for a timestamp.
PRESENCE_PERSIST_S = float(os.getenv("HAZEHUB_PRESENCE_PERSIST", "3600"))
_presence: dict[str, float] = {}
_presence_persisted: dict[str, float] = {}
_presence_lock = threading.Lock()


def touch_presence(scout_id: str) -> None:
    now = time.time()
    with _presence_lock:
        _presence[scout_id] = now
        last = _presence_persisted.get(scout_id, 0.0)
        due = now - last >= PRESENCE_PERSIST_S
        if due:
            _presence_persisted[scout_id] = now
    if not due:
        return
    s = scouter(scout_id)
    if s is not None:
        s.last_seen = _now()
        store.coalesce(s, delay_s=10.0)


def last_seen(s: Scouter) -> Optional[datetime]:
    with _presence_lock:
        live = _presence.get(s.scout_id)
    if live:
        return datetime.fromtimestamp(live, tz=timezone.utc)
    return s.last_seen


# --------------------------------------------------------------------------- #
# events                                                                       #
# --------------------------------------------------------------------------- #
def event(event_key: str) -> Optional[Event]:
    return store.get(schema.EVENTS, event_key)


def events() -> list[Event]:
    """Every event this installation knows about, newest start date first."""
    rows = store.all(schema.EVENTS)
    return sorted(
        rows,
        key=lambda e: (e.start_date is not None, e.start_date, e.event_key),
        reverse=True,
    )


# --------------------------------------------------------------------------- #
# seasons + season_revisions                                                   #
# --------------------------------------------------------------------------- #
def season(season_id: str) -> Optional[Season]:
    return store.get(schema.SEASONS, (season_id or "").strip())


def seasons() -> list[Season]:
    """Every season, newest year first."""
    return sorted(store.all(schema.SEASONS), key=lambda s: (s.year, s.season_id), reverse=True)


def save_season(row: Season) -> None:
    store.write(row)


def season_revision(season_id: str, version: int) -> Optional[SeasonRevision]:
    doc_id = f"{(season_id or '').strip()}@{int(version):06d}"
    row = store.get(schema.SEASON_REVISIONS, doc_id)
    if row is not None:
        return row
    return _read_revision(schema.SEASON_REVISIONS, doc_id, SeasonRevision)


def season_revisions(season_id: str, limit: int = 100) -> list[SeasonRevision]:
    """A season's game history, newest first."""
    rows = _all_revisions(schema.SEASON_REVISIONS, SeasonRevision, "season_id", season_id)
    return rows[:limit]


def save_season_revision(row: SeasonRevision) -> None:
    store.write(row)


# --------------------------------------------------------------------------- #
# Revision history helpers                                                     #
# --------------------------------------------------------------------------- #
# Revision collections are append-only and grow all season, so they are not
# mirrored into RAM (see schema.WRITE_ONLY). They are read straight from the
# datastore, which is affordable because only a history panel asks for them.
def _read_revision(collection: str, doc_id: str, model):
    try:
        raw = store.backend.load(collection, None)
    except Exception:  # noqa: BLE001
        return None
    data = raw.get(doc_id)
    return model.from_doc(doc_id, data) if data else None


def _all_revisions(collection: str, model, owner_field: str, owner: str) -> list:
    owner = (owner or "").strip()
    try:
        raw = store.backend.load(collection, None)
    except Exception:  # noqa: BLE001
        return []
    rows = [
        model.from_doc(doc_id, data)
        for doc_id, data in raw.items()
        if (data or {}).get(owner_field) == owner
    ]
    rows.sort(key=lambda r: r.version, reverse=True)
    return rows


# --------------------------------------------------------------------------- #
# forms + form_revisions                                                       #
# --------------------------------------------------------------------------- #
def form(form_id: str) -> Optional[Form]:
    return store.get(schema.FORMS, (form_id or "").strip())


def forms(*, include_archived: bool = False, season_id: str = "") -> list[Form]:
    rows = store.all(schema.FORMS)
    if not include_archived:
        rows = [f for f in rows if not f.archived]
    if season_id:
        rows = [f for f in rows if f.season_id == season_id]
    return sorted(rows, key=lambda f: (f.kind, f.name.lower()))


def save_form(row: Form) -> None:
    store.write(row)


def form_revision(form_id: str, version: int) -> Optional[FormRevision]:
    doc_id = f"{(form_id or '').strip()}@{int(version):06d}"
    row = store.get(schema.FORM_REVISIONS, doc_id)
    if row is not None:
        return row
    return _read_revision(schema.FORM_REVISIONS, doc_id, FormRevision)


def form_revisions(form_id: str, limit: int = 100) -> list[FormRevision]:
    """A form's history, newest first."""
    return _all_revisions(schema.FORM_REVISIONS, FormRevision, "form_id", form_id)[:limit]


def save_form_revision(row: FormRevision) -> None:
    """Write a revision. Never overwrites: a version number is used once."""
    store.write(row)


# --------------------------------------------------------------------------- #
# event_archives                                                               #
# --------------------------------------------------------------------------- #
def archive(event_key: str) -> Optional[EventArchive]:
    return store.get(schema.EVENT_ARCHIVES, (event_key or "").strip())


def archive_detail(event_key: str) -> Optional[EventArchive]:
    row = archive(event_key)
    if row is None:
        return None
    if not row.chunk_ids:
        return row

    chunks: list[EventArchiveChunk] = []
    for chunk_id in row.chunk_ids:
        chunk = store.fetch(schema.EVENT_ARCHIVE_CHUNKS, chunk_id)
        if chunk is not None:
            chunks.append(chunk)
    chunks.sort(key=lambda c: (c.kind, c.index))

    hydrated = EventArchive.from_doc(row.doc_id, row.to_doc())
    list_fields = {"matches", "scouting", "pit_raw", "picklists_raw", "bets", "team_cache"}
    dict_fields = {"event", "analytics"}
    for kind in list_fields:
        values: list = []
        for chunk in chunks:
            if chunk.kind == kind and isinstance(chunk.data, list):
                values.extend(chunk.data)
        setattr(hydrated, kind, values)
    for kind in dict_fields:
        for chunk in chunks:
            if chunk.kind == kind and isinstance(chunk.data, dict):
                setattr(hydrated, kind, chunk.data)
                break
    return hydrated


def archives() -> list[EventArchive]:
    """Every archived event, most recently archived first."""
    return sorted(
        store.all(schema.EVENT_ARCHIVES),
        key=lambda a: a.archived_at,
        reverse=True,
    )


def save_archive(row: EventArchive, chunks: list[EventArchiveChunk] | None = None) -> None:
    if chunks:
        store.write_many(chunks)
    store.write(row)


def delete_archive(event_key: str) -> None:
    store.delete(schema.EVENT_ARCHIVES, (event_key or "").strip())


def reconcile_current_event() -> str:
    """Make sure the current event pointer names an event that exists.

    The pointer is one string in ``app_settings`` and every screen reads
    through it, so when it goes stale the whole app looks empty: the schedule
    is blank, scouting returns nothing, and reconciliation reports every match
    as unscouted, all while the data sits in the datastore under another key.

    Called once at startup, and it only acts when the pointer is unusable, so
    the normal case costs nothing. An event with a schedule and no scouting is
    left alone: that is exactly what a competition looks like the morning
    before it starts. It also refuses to choose between two plausible events,
    because silently switching events mid-competition would be much worse than
    an empty page somebody can fix in the dashboard.
    """
    current = current_event()
    known = {e.event_key for e in events()}
    if current and current in known:
        return current

    # The match cache only holds the current event, so candidates have to be
    # counted against the datastore. This runs once, and only when the pointer
    # is already broken, so the reads are worth it.
    def match_count(key: str) -> int:
        try:
            return len(store.backend.load(schema.MATCHES, key))
        except Exception:  # noqa: BLE001
            return 0

    candidates = [e.event_key for e in events() if match_count(e.event_key)]

    if current:
        log.warning(
            "current event %r is not a known event; events with a schedule: %s",
            current, ", ".join(candidates) or "none",
        )

    if not candidates:
        log.warning("no event has a schedule; leaving the pointer at %r", current)
        return current

    if len(candidates) > 1:
        log.warning(
            "leaving the current event at %r: %d events have schedules (%s) and "
            "guessing could switch the event mid-competition. Set it in the "
            "Admin dashboard.",
            current or "(unset)", len(candidates), ", ".join(candidates),
        )
        return current

    chosen = candidates[0]
    log.warning("repaired the current event pointer: %r -> %r", current or "(unset)", chosen)
    set_setting("current_event", chosen)
    return chosen


def save_event(e: Event) -> None:
    store.write(e)


# --------------------------------------------------------------------------- #
# matches                                                                      #
# --------------------------------------------------------------------------- #
_COMP_ORDER = {"qm": 0, "ef": 1, "qf": 2, "sf": 3, "f": 4}


def matches_for_event(event_key: str) -> list[MatchRecord]:
    """Every match at ``event_key``, in play order."""

    def build() -> list[MatchRecord]:
        rows = [m for m in store.all(schema.MATCHES) if m.event_key == event_key]
        rows.sort(key=lambda m: (_COMP_ORDER.get(m.comp_level, 9), m.match_number))
        return rows

    return memoized(f"matches:{event_key}", (schema.MATCHES,), build)


def match_by_key(match_key: str) -> Optional[MatchRecord]:
    return store.get(schema.MATCHES, match_key)


def match_by_number(
    event_key: str, comp_level: str, match_number: int
) -> Optional[MatchRecord]:
    return store.get(
        schema.MATCHES, schema.match_id(event_key, comp_level, match_number)
    )


def save_match(m: MatchRecord) -> bool:
    m.updated_at = _now()
    return store.write(m)


def save_matches(rows: list[MatchRecord]) -> int:
    """Bulk upsert. Unchanged matches are skipped, which is what keeps a
    schedule re-sync from costing one write per match every time."""
    for m in rows:
        m.updated_at = _now()
    return store.write_many(rows)


def replace_event_schedule(event_key: str, rows: list[MatchRecord]) -> int:
    """Atomically replace an event schedule after the whole CSV validates."""
    for row in rows:
        row.updated_at = _now()
    old_ids = {m.doc_id for m in matches_for_event(event_key)}
    new_ids = {m.doc_id for m in rows}
    deletes = [(schema.MATCHES, doc_id) for doc_id in old_ids - new_ids]
    return store.atomic_replace(rows, deletes)


def delete_matches_for_event(event_key: str) -> int:
    ids = [m.match_key for m in store.all(schema.MATCHES) if m.event_key == event_key]
    return store.delete_many(schema.MATCHES, ids)


def delete_event(event_key: str) -> None:
    store.delete(schema.EVENTS, (event_key or "").strip())


# --------------------------------------------------------------------------- #
# match_scouting                                                               #
# --------------------------------------------------------------------------- #
def _scouting_index(event_key: str) -> dict[str, dict[Any, list[ScoutEntry]]]:
    """Group this event's submissions by team, by match and by scouter once
    per change, instead of scanning every submission on every request."""

    def build() -> dict[str, dict[Any, list[ScoutEntry]]]:
        by_team: dict[int, list[ScoutEntry]] = {}
        by_match: dict[int, list[ScoutEntry]] = {}
        by_scout: dict[str, list[ScoutEntry]] = {}
        rows = [e for e in store.all(schema.MATCH_SCOUTING) if e.event_key == event_key]
        from .scouting_review import effective_entries
        rows = effective_entries(rows, scouting_audits(event_key))
        from .epa_scoring import rescore_reports
        rows = rescore_reports(rows, store.all(schema.MATCHES), store.all(schema.TEAM_CACHE))
        rows.sort(key=lambda e: (e.match_number, e.id))
        for e in rows:
            by_team.setdefault(e.team_number, []).append(e)
            by_match.setdefault(e.match_number, []).append(e)
            by_scout.setdefault(e.scout_id, []).append(e)
        return {"all": rows, "team": by_team, "match": by_match, "scout": by_scout}

    return memoized(f"scouting:{event_key}", (schema.MATCH_SCOUTING, schema.SCOUTING_AUDIT, schema.MATCHES,
        schema.TEAM_CACHE, schema.SEASONS, schema.SEASON_REVISIONS, schema.APP_SETTINGS), build)


def scouting_audits(event_key: str) -> list:
    return [row for row in store.all(schema.SCOUTING_AUDIT)
            if row.event_key == event_key]


def create_scouting_audit(row) -> bool:
    return store.create(row)


def scouting_for_event(event_key: str) -> list[ScoutEntry]:
    return _scouting_index(event_key)["all"]


def scouting_for_team(event_key: str, team: int) -> list[ScoutEntry]:
    return _scouting_index(event_key)["team"].get(int(team), [])


def scouting_for_match(event_key: str, match_number: int) -> list[ScoutEntry]:
    return _scouting_index(event_key)["match"].get(int(match_number), [])


def scouting_for_scout(scout_id: str, event_key: str = "") -> list[ScoutEntry]:
    """A scouter's own submissions, newest first.

    Scoped to the cached event; the cache only holds the current event, which
    is exactly what the "my entries" screen shows.
    """
    event_key = event_key or store.event_key
    rows = _scouting_index(event_key)["scout"].get(scout_id, [])
    return sorted(rows, key=lambda e: e.id, reverse=True)


def scouting_by_submission(submission_id: str) -> Optional[ScoutEntry]:
    """Look up by submission UUID: the document ID, so this is a dict hit."""
    return store.get(schema.MATCH_SCOUTING, (submission_id or "").strip())


def event_teams(event_key: str) -> list[int]:
    return sorted(_scouting_index(event_key)["team"].keys())


def create_scouting(entry: ScoutEntry) -> bool:
    """Insert a submission. False means this UUID was already stored.

    The document ID is the submission UUID, so Firestore's ``create()``
    enforces the schema's UNIQUE constraint: a device replaying its offline
    queue cannot produce a duplicate row no matter how many times it retries.
    """
    entry.azure_received_at = _now()
    entry.cloud_status = "synced"
    return store.create(entry)


def delete_scouting_for_event(event_key: str) -> int:
    ids = [
        e.submission_id
        for e in store.all(schema.MATCH_SCOUTING)
        if e.event_key == event_key
    ]
    return store.delete_many(schema.MATCH_SCOUTING, ids)


def scouting_total() -> int:
    return store.count(schema.MATCH_SCOUTING)


# --------------------------------------------------------------------------- #
# pit_scouting                                                                 #
# --------------------------------------------------------------------------- #
def pit(event_key: str, team_number: int) -> Optional[PitEntry]:
    return store.get(schema.PIT_SCOUTING, schema.pit_id(event_key, team_number))


def pits_for_event(event_key: str) -> list[PitEntry]:
    """Every pit report at this event, lowest team number first.

    The collection is mirrored into RAM scoped to the current event, so this
    is a list comprehension rather than a query.
    """
    key = (event_key or "").strip()
    rows = [r for r in store.all(schema.PIT_SCOUTING) if not key or r.event_key == key]
    return sorted(rows, key=lambda r: r.team_number)


def save_pit(row: PitEntry) -> None:
    photo = row.robot_photo or ""
    if len(photo.encode("utf-8")) > schema.MAX_PHOTO_BYTES:
        raise WriteTooLarge(
            "Robot photo is too large for a Firestore document "
            f"({len(photo) // 1024} KiB, limit {schema.MAX_PHOTO_BYTES // 1024} KiB). "
            "Upload it to Cloud Storage and store the URL instead."
        )
    row.updated_at = _now()
    store.write(row)


def pit_photo_images(row: PitEntry) -> list[str]:
    """Load only the photos referenced by one report, never the whole event."""
    images = [row.robot_photo] if row.robot_photo else []
    if store.backend is None:
        return images
    for photo_id in row.photo_ids:
        try:
            data = store.backend.get(schema.PIT_PHOTOS, photo_id)
        except Exception:  # noqa: BLE001 - report text remains usable offline
            data = None
        if data and data.get("event_key") == row.event_key and int(data.get("team_num") or 0) == row.team_number:
            image = data.get("image") or ""
            if image:
                images.append(image)
    return images


def save_pit_with_photos(row: PitEntry, images: list[str]) -> None:
    """Atomically save the report and its deduplicated, independently stored photos."""
    clean: list[str] = []
    for image in images:
        image = str(image or "")
        if not image:
            continue
        if not image.startswith("data:image/"):
            raise ValueError("Pit photos must be images captured by this app")
        size = len(image.encode("utf-8"))
        if size > schema.MAX_PHOTO_BYTES:
            raise WriteTooLarge(
                f"A robot photo is {size // 1024} KiB; the compressed-photo limit is "
                f"{schema.MAX_PHOTO_BYTES // 1024} KiB"
            )
        clean.append(image)
    # A SHA-based ID makes retries and repeated saves free of duplicates.
    photos: list[PitPhoto] = []
    for image in dict.fromkeys(clean):
        digest = hashlib.sha256(image.encode("utf-8")).hexdigest()[:32]
        photo_id = f"{row.event_key}_{row.team_number}_{digest}"
        photos.append(PitPhoto(photo_id, row.event_key, row.team_number, image))
    old_ids = set(row.photo_ids)
    for photo in photos:
        store.create_uncached(photo)
    row.photo_ids = [photo.id for photo in photos]
    row.robot_photo = ""  # legacy single-photo field is migrated on the next save
    row.updated_at = _now()
    store.atomic_replace([row], [])
    retired = list(old_ids - set(row.photo_ids))
    if retired:
        # Cleanup is safe after the manifest changes: failures leave invisible
        # orphan bytes, never a report that references a missing photo.
        store.delete_many(schema.PIT_PHOTOS, retired)


def delete_pits_for_event(event_key: str) -> int:
    rows = [p for p in store.all(schema.PIT_SCOUTING) if p.event_key == event_key]
    ids = [p.doc_id for p in rows]
    deleted = store.delete_many(schema.PIT_SCOUTING, ids)
    photo_ids = [photo_id for row in rows for photo_id in row.photo_ids]
    if photo_ids:
        store.delete_many(schema.PIT_PHOTOS, photo_ids)
    return deleted


# --------------------------------------------------------------------------- #
# picklists                                                                    #
# --------------------------------------------------------------------------- #
def picklists(event_key: str = "") -> list[Picklist]:
    rows = store.all(schema.PICKLISTS)
    if event_key:
        rows = [p for p in rows if p.event_key == event_key]
    return rows


def picklist(pid: int) -> Optional[Picklist]:
    return store.get(schema.PICKLISTS, str(pid))


def find_picklist(event_key: str, owner_id: str, is_master: bool) -> Optional[Picklist]:
    for p in picklists(event_key):
        if p.owner_id == owner_id and bool(p.is_master) == bool(is_master):
            return p
    return None


def find_picklist_round(
    event_key: str, owner_id: str, pick_round: int, is_master: bool
) -> Optional[Picklist]:
    """One list per owner per pick round (first pick / second pick)."""
    for p in picklists(event_key):
        if (
            p.owner_id == owner_id
            and int(p.pick_round) == int(pick_round)
            and bool(p.is_master) == bool(is_master)
        ):
            return p
    return None


def save_picklist(p: Picklist) -> None:
    p.updated_at = _now()
    store.write(p)


def delete_picklist(pid: int) -> None:
    store.delete(schema.PICKLISTS, str(pid))


def delete_picklists_for_event(event_key: str) -> int:
    ids = [p.doc_id for p in store.all(schema.PICKLISTS) if p.event_key == event_key]
    return store.delete_many(schema.PICKLISTS, ids)


# --------------------------------------------------------------------------- #
# bets                                                                         #
# --------------------------------------------------------------------------- #
def bets(event_key: str = "") -> list[Bet]:
    rows = store.all(schema.BETS)
    if event_key:
        rows = [b for b in rows if b.event_key == event_key]
    return sorted(rows, key=lambda b: b.id, reverse=True)


def bet(bet_id: int) -> Optional[Bet]:
    return store.get(schema.BETS, str(bet_id))


def bets_for_scout(scout_id: str) -> list[Bet]:
    return [b for b in bets() if b.scout_id == scout_id]


def bets_by_scout() -> dict[str, list[Bet]]:
    """One pass over every bet, memoised: the leaderboard used to run a query
    per scouter, which is 60 scans of the same collection per page load."""

    def build() -> dict[str, list[Bet]]:
        out: dict[str, list[Bet]] = {}
        for b in store.all(schema.BETS):
            out.setdefault(b.scout_id, []).append(b)
        return out

    return memoized("bets:by_scout", (schema.BETS,), build)


def open_bets_for_match(match_key: str) -> list[Bet]:
    return [
        b for b in store.all(schema.BETS)
        if b.match_key == match_key and b.status == "open"
    ]


def save_bet(b: Bet) -> None:
    store.write(b)


def save_bets(rows: list[Bet]) -> int:
    return store.write_many(rows)


def delete_bet(bet_id: int) -> None:
    store.delete(schema.BETS, str(bet_id))


def delete_all_bets() -> int:
    return store.delete_many(
        schema.BETS, [b.doc_id for b in store.all(schema.BETS)]
    )


def delete_bets_for_event(event_key: str) -> int:
    ids = [b.doc_id for b in store.all(schema.BETS) if b.event_key == event_key]
    return store.delete_many(schema.BETS, ids)


# --------------------------------------------------------------------------- #
# team_cache                                                                   #
# --------------------------------------------------------------------------- #
def team(team_number: int) -> Optional[TeamCache]:
    return store.get(schema.TEAM_CACHE, schema.team_id(team_number))


def teams() -> list[TeamCache]:
    return store.all(schema.TEAM_CACHE)


def save_team(tc: TeamCache) -> None:
    tc.updated_at = _now()
    try:
        store.write(tc)
    except WriteTooLarge:
        # An oversized TBA avatar or photo list must not break team sync.
        tc.photos = tc.photos[:2]
        if len(tc.avatar.encode("utf-8")) > schema.MAX_PHOTO_BYTES:
            tc.avatar = ""
        store.write(tc)


def epa_map(event_key: str) -> dict[int, float]:
    def build() -> dict[int, float]:
        out: dict[int, float] = {}
        for t in event_teams(event_key):
            tc = team(t)
            if tc and tc.epa is not None:
                out[t] = float(tc.epa)
        return out

    return memoized(
        f"epa:{event_key}", (schema.MATCH_SCOUTING, schema.TEAM_CACHE), build
    )


# --------------------------------------------------------------------------- #
# devices / network_status / sync_outbox                                       #
# --------------------------------------------------------------------------- #
DEVICE_WRITE_INTERVAL_S = 120.0
_device_written: dict[str, float] = {}


def devices() -> list[Device]:
    return store.all(schema.DEVICES)


def record_device(d: Device) -> None:
    """Upsert a device heartbeat, throttled.

    Devices check in often; the panel reads from memory, so Firestore only
    needs the occasional durable snapshot. Non-essential: the quota guard
    drops these first if a day ever runs hot.
    """
    d.last_seen_at = _now()
    now = time.monotonic()
    if now - _device_written.get(d.device_id, 0.0) < DEVICE_WRITE_INTERVAL_S:
        store.coalesce(d, delay_s=DEVICE_WRITE_INTERVAL_S)
        return
    _device_written[d.device_id] = now
    store.write(d, essential=False)


NETWORK_WRITE_INTERVAL_S = 300.0
_network_written = 0.0
_network_latest: Optional[NetworkStatus] = None


def record_network_status(status: NetworkStatus) -> None:
    """Append a venue-uplink snapshot at most once every five minutes."""
    global _network_written, _network_latest
    _network_latest = status
    now = time.monotonic()
    if now - _network_written < NETWORK_WRITE_INTERVAL_S:
        return
    _network_written = now
    status.id = next_seq_id()
    store.write(status, essential=False)


def latest_network_status() -> Optional[NetworkStatus]:
    return _network_latest


def record_outbox_failure(record: OutboxRecord) -> None:
    """Persist a submission a device gave up on, so it can be chased later."""
    store.write(record, essential=False)


# --------------------------------------------------------------------------- #
# Diagnostics                                                                  #
# --------------------------------------------------------------------------- #
def cache_stats() -> dict[str, Any]:
    return store.stats()
