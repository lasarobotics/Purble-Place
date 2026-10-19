"""Firestore schema for HazeHub: collections, document IDs, index policy.

This is the single place that describes *how* the HazeHub DB schema is laid
out in Cloud Firestore. ``models.py`` serialises to these shapes and
``cache.py`` decides what to keep resident in memory from these declarations.

Schema source
-------------
Straight from the team's design doc (``HazeHub DB Schema.txt``):

    scouters(scouter_id PK, s_number, display_name, is_admin)
    events(event_key PK)
    matches(comp_level, match_num, red1..red3, blue1..blue3)
    match_scouting(id, event_key, comp_level, match_num, team_num, alliance,
                   scouter_id, data JSONB, no_show, comments, submitted_at,
                   submission_uuid UNIQUE, client_timestamp,
                   megascout_received_at, azure_received_at, cloud_status)
    picklists(picklist_name, {rank}_team_number_comments)
    sync_outbox(outbox_id, submission_uuid, status, attempt_count,
                last_attempt_at, acknowledged_at, created_at)
    network_status(status_id, recorded_at, active_carrier, signal_quality,
                   packet_loss, postgres_status, unsynced_count,
                   oldest_queued_submission_uuid)
    devices(device_id PK, role, vlan_port, last_seen_at, battery_pct)

Relational → Firestore translation
----------------------------------
* Every table becomes a **top-level collection with the same name**. Firestore
  has no joins, so ``event_key`` stays a field (not a subcollection path) and
  every event-scoped query is a single equality filter: which Firestore
  serves from the automatic single-field index, so **no composite indexes are
  required by this app**.
* Surrogate keys (``BIGSERIAL``) become deterministic document IDs. That is
  the single biggest correctness win of the migration: ``match_scouting`` is
  keyed by ``submission_uuid``, so the UNIQUE constraint from the schema is
  enforced by Firestore itself and an offline device replaying its queue can
  physically not create a duplicate row.
* ``JSONB`` columns become nested maps (``data``, ``items``, ``film_events``).
* ``TIMESTAMPTZ`` becomes a Firestore timestamp (always tz-aware UTC).

Quota policy baked into this file
---------------------------------
``INDEX_EXEMPT_FIELDS`` lists fields that must NOT be indexed. Firestore
charges index writes and caps a document at 40,000 index entries; the big
JSON blobs (heatmap arrays, picklist items, base64 avatars) are never queried
by value, so indexing them is pure cost. ``firestore.indexes.json`` is
generated from this list.

``MAX_DOC_BYTES`` guards the hard 1 MiB per-document limit before a write is
attempted, so an oversized pit photo fails with a clear 413 instead of a
Firestore error mid-batch.
"""
from __future__ import annotations

# --------------------------------------------------------------------------- #
# Collections                                                                  #
# --------------------------------------------------------------------------- #
SCOUTERS = "scouters"
ACCOUNT_AUDIT = "account_audit"
EVENTS = "events"
MATCHES = "matches"
MATCH_SCOUTING = "match_scouting"
SCOUTING_AUDIT = "scouting_audit"
PICKLISTS = "picklists"
PICKLIST_RECORDS = "picklist_records"
PICKLIST_WORKSPACES = "picklist_workspaces"
PICKLIST_HISTORY = "picklist_history"
BETS = "bets"
PIT_SCOUTING = "pit_scouting"
PIT_PHOTOS = "pit_photos"
TEAM_CACHE = "team_cache"
APP_SETTINGS = "app_settings"
SYNC_OUTBOX = "sync_outbox"
NETWORK_STATUS = "network_status"
DEVICES = "devices"
#: One rolled-up document per finished event (see app/archive.py).
EVENT_ARCHIVES = "event_archives"
#: Detail documents for large event archives. The archive summary stores only
#: chunk IDs so old events do not make the admin dashboard expensive to list.
EVENT_ARCHIVE_CHUNKS = "event_archive_chunks"
#: Form definitions and their append-only history (see app/forms.py).
FORMS = "forms"
FORM_REVISIONS = "form_revisions"
#: Seasons and their versioned game definitions (see app/seasons.py). A season
#: is the unit that owns a game, its forms, its scouting and its analytics, so
#: that last year's data keeps meaning what it meant last year.
SEASONS = "seasons"
SEASON_REVISIONS = "season_revisions"

ALL_COLLECTIONS = (
    ACCOUNT_AUDIT,
    SCOUTERS,
    EVENTS,
    MATCHES,
    MATCH_SCOUTING,
    SCOUTING_AUDIT,
    PICKLISTS, PICKLIST_RECORDS, PICKLIST_WORKSPACES, PICKLIST_HISTORY,
    BETS,
    PIT_SCOUTING,
    PIT_PHOTOS,
    TEAM_CACHE,
    APP_SETTINGS,
    SYNC_OUTBOX,
    NETWORK_STATUS,
    DEVICES,
    EVENT_ARCHIVES,
    EVENT_ARCHIVE_CHUNKS,
    FORMS,
    FORM_REVISIONS,
    SEASONS,
    SEASON_REVISIONS,
)

#: Collections mirrored into RAM in full. Small, global, read on every page.
# Forms are global and read on every scouting page load, so the current
# definitions are mirrored. The revision history is not: it is append-only,
# grows without bound, and is only read on the builder's history panel.
GLOBAL_CACHED = (
    SCOUTERS, EVENTS, TEAM_CACHE, APP_SETTINGS, DEVICES, EVENT_ARCHIVES, FORMS,
    SEASONS,
)

#: Collections mirrored into RAM filtered to the current event. These grow
#: with the competition, so scoping the listener to one event keeps both the
#: memory footprint and the listener's initial read cost bounded.
EVENT_SCOPED_CACHED = (MATCHES, MATCH_SCOUTING, SCOUTING_AUDIT, PICKLISTS, BETS, PIT_SCOUTING)

#: Written but never listened to: nothing in the UI reads them hot.
WRITE_ONLY = (ACCOUNT_AUDIT, PICKLIST_RECORDS, PICKLIST_WORKSPACES, PICKLIST_HISTORY, PIT_PHOTOS, SYNC_OUTBOX, NETWORK_STATUS, FORM_REVISIONS, SEASON_REVISIONS, EVENT_ARCHIVE_CHUNKS)


# --------------------------------------------------------------------------- #
# Document IDs                                                                 #
# --------------------------------------------------------------------------- #
def match_id(event_key: str, comp_level: str, match_num: int) -> str:
    """TBA-style match key, e.g. ``2026txman_qm12``: also the document ID."""
    return f"{event_key}_{comp_level}{int(match_num)}"


def pit_id(event_key: str, team_num: int) -> str:
    """One pit report per team per event (the schema's UNIQUE(event, team))."""
    return f"{event_key}_{int(team_num)}"


def team_id(team_num: int) -> str:
    return str(int(team_num))


_ID_FORBIDDEN = ("/", "\x00")


def safe_doc_id(value: str) -> str:
    """Validate a user-supplied document ID against Firestore's rules.

    Firestore rejects IDs containing ``/``, the IDs ``.`` and ``..``, IDs
    matching ``__.*__``, and IDs over 1500 bytes. Scouter IDs come from a
    login box, so they are checked before they can reach a write.
    """
    v = (value or "").strip()
    if not v:
        raise ValueError("ID cannot be empty")
    if v in (".", ".."):
        raise ValueError("ID cannot be '.' or '..'")
    if v.startswith("__") and v.endswith("__"):
        raise ValueError("ID cannot match __*__ (reserved by Firestore)")
    for bad in _ID_FORBIDDEN:
        if bad in v:
            raise ValueError(f"ID cannot contain {bad!r}")
    if len(v.encode("utf-8")) > 1500:
        raise ValueError("ID is longer than Firestore's 1500-byte limit")
    return v


# --------------------------------------------------------------------------- #
# Hard Firestore limits we write against                                       #
# --------------------------------------------------------------------------- #
#: 1 MiB per document. We refuse at 900 KiB so field overhead can never tip a
#: write over the real ceiling.
MAX_DOC_BYTES = 900 * 1024

#: 500 operations per batched write / transaction. Chunk below it.
MAX_BATCH_OPS = 450

#: 10 MiB per commit. Batches also flush when they reach this many bytes.
MAX_BATCH_BYTES = 8 * 1024 * 1024

#: Sustained writes to a single document are limited to ~1/second. Anything
#: that could be written more often than this is coalesced (see cache.Writer).
MIN_DOC_WRITE_INTERVAL_S = 1.0

#: Firestore caps ``in`` / ``array-contains-any`` at 30 values. The cache
#: serves every multi-key lookup from RAM, so we never issue one: this
#: constant exists so a future query can assert against it.
MAX_IN_CLAUSE = 30

#: Bounds that keep a single scouting document far away from MAX_DOC_BYTES
#: and from the 40k index-entries-per-document cap.
MAX_HEATMAP_ATTEMPTS = 400
MAX_NOTES_CHARS = 5000
MAX_TAGS = 40
#: Pit robot photos are data URIs pasted from a tablet camera. Anything above
#: this belongs in Cloud Storage, not in a Firestore document.
MAX_PHOTO_BYTES = 700 * 1024


# --------------------------------------------------------------------------- #
# Index policy                                                                 #
# --------------------------------------------------------------------------- #
#: Fields exempted from *all* single-field indexing. These are JSON payloads
#: and blobs that are only ever read whole, never filtered or ordered on.
#: Exempting them removes index-entry writes (cheaper, faster writes) and keeps
#: array-of-map fields from eating into the 40,000 index entries per document.
INDEX_EXEMPT_FIELDS: dict[str, tuple[str, ...]] = {
    MATCH_SCOUTING: ("data", "comments", "payload_hash"),
    SCOUTING_AUDIT: ("patch", "before", "reason"),
    MATCHES: ("film_events", "film_summary", "youtube_key"),
    PICKLISTS: ("items",),
    "picklist_records": ("items",),
    "picklist_workspaces": ("boards", "notes", "team_statuses", "undo", "redo", "published"),
    "picklist_history": ("snapshot", "published"),
    TEAM_CACHE: ("avatar", "photos", "record"),
    PIT_SCOUTING: ("robot_photo", "capabilities", "notes"),
    PIT_PHOTOS: ("image",),
    EVENT_ARCHIVE_CHUNKS: ("data",),
    NETWORK_STATUS: ("packet_loss",),
}

#: Fields each event-scoped collection is filtered by. Single equality filters
#: only: served by Firestore's automatic single-field indexes, so this app
#: ships zero composite indexes.
EVENT_FILTER_FIELD = "event_key"


def index_exemptions() -> list[dict]:
    """``fieldOverrides`` entries for firestore.indexes.json."""
    out: list[dict] = []
    for collection, fields in INDEX_EXEMPT_FIELDS.items():
        for field in fields:
            out.append(
                {
                    "collectionGroup": collection,
                    "fieldPath": field,
                    "indexes": [],
                }
            )
    return out
