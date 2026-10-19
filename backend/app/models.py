"""Firestore document models for HazeHub.

Every class here is a plain dataclass that knows how to convert itself to and
from a Firestore document. There is no ORM and no session: ``repo.py`` reads
from the in-memory mirror in ``cache.py`` and writes through to Firestore.

Two naming systems meet in this file, on purpose:

* **Document fields** use the names from the team's DB schema
  (``scouter_id``, ``match_num``, ``team_num``, ``comments``, ``submitted_at``,
  ``submission_uuid``...), so what is stored in Firestore matches the design doc
  and any SQL export lines up column-for-column.
* **Python attributes** keep the names the rest of the codebase and the JSON
  API already use (``scout_id``, ``match_number``, ``team_number``, ``notes``,
  ``created_at``, ``submission_id``...), so analytics, routers and the frontend
  contract are untouched by the migration.

``to_doc()`` / ``from_doc()`` are the only places the two vocabularies meet.

Surrogate IDs
-------------
Postgres ``BIGSERIAL`` has no Firestore equivalent, and a counter document
would be both an extra read/write per insert and a hotspot against the
~1 write/second per-document ceiling. ``next_seq_id()`` mints a monotonic,
time-ordered 64-bit integer in-process instead: no I/O, still sorts
chronologically (so ``order by id desc`` still means "newest first"), and
comfortably inside JavaScript's safe integer range so the frontend's
``id: number`` typing keeps working unchanged.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Optional, ClassVar

from . import schema

# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(timezone.utc)


def new_submission_id() -> str:
    return str(uuid.uuid4())


_seq_lock = threading.Lock()
_seq_last = 0


def next_seq_id() -> int:
    """Monotonic, time-ordered surrogate ID (replaces BIGSERIAL).

    ``ms * 1000 + n`` gives 1000 IDs per millisecond and lands around 1.8e15: under JavaScript's 2^53 safe-integer ceiling, so the frontend can keep
    treating IDs as numbers.
    """
    global _seq_last
    with _seq_lock:
        candidate = int(time.time() * 1000) * 1000
        if candidate <= _seq_last:
            candidate = _seq_last + 1
        _seq_last = candidate
        return candidate


def as_utc(value: Any) -> Optional[datetime]:
    """Normalise anything Firestore or a client may hand us to aware UTC.

    The Admin SDK returns ``DatetimeWithNanoseconds`` (a datetime subclass);
    clients send ISO 8601 strings, sometimes with a trailing ``Z``.
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):  # epoch seconds
        return datetime.fromtimestamp(value, tz=timezone.utc)
    return None


def iso(value: Optional[datetime]) -> Optional[str]:
    dt = as_utc(value)
    return dt.isoformat() if dt else None


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# scouters                                                                     #
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# Account roles                                                                #
# --------------------------------------------------------------------------- #
#: What each role can do.
#:
#:   scouter   collects data. Everything a normal account does today. Their
#:             picklists are visible to strategy and admin, but rank lowest.
#:   strategy  scouter plus every analysis screen. Their picklists outrank
#:             scouter lists during the picklist meeting.
#:   admin     identical to strategy, plus event control and the film tab.
#:   picklist  the account used on the shared screen during a picklist
#:             meeting. It can reach picklists and team data and nothing else,
#:             so a stray tap cannot advance the match or settle bets.
ROLE_SCOUTER = "scouter"
ROLE_STRATEGY = "strategy"
ROLE_ADMIN = "admin"
ROLE_PICKLIST = "picklist"

ROLES = (ROLE_SCOUTER, ROLE_STRATEGY, ROLE_ADMIN, ROLE_PICKLIST)

#: Roles allowed on the analysis and event-control screens.
ADMIN_ROLES = (ROLE_STRATEGY, ROLE_ADMIN)

#: Ranking used when several picklists are shown together. Lower sorts first.
PICKLIST_PRIORITY = {
    "master": 0,
    ROLE_ADMIN: 1,
    ROLE_STRATEGY: 1,
    ROLE_SCOUTER: 2,
    ROLE_PICKLIST: 2,
}


def normalize_role(value: Any, *, is_admin: bool = False) -> str:
    """Coerce stored data to a known role.

    Accounts created before roles existed only have ``is_admin``; that is the
    fallback so an existing admin does not lose access on upgrade.
    """
    role = str(value or "").strip().lower()
    if role in ROLES:
        return role
    return ROLE_ADMIN if is_admin else ROLE_SCOUTER


@dataclass
class Scouter:
    """``scouters``: document ID is ``scouter_id``."""

    scout_id: str
    password_hash: str = ""
    active: bool = True
    deleted: bool = False
    name_confirmed: bool = False
    auth_revision: int = 0
    s_number: Optional[int] = None
    display_name: str = ""
    role: str = ROLE_SCOUTER
    last_seen: datetime = field(default_factory=_now)   # -> last_login
    bucks: int = 100
    matches_scouted: int = 0
    created_at: datetime = field(default_factory=_now)

    COLLECTION = schema.SCOUTERS

    @property
    def doc_id(self) -> str:
        return self.scout_id

    @property
    def is_admin(self) -> bool:
        """Kept as a property so existing checks and the API shape still work."""
        return self.role == ROLE_ADMIN

    @property
    def can_open_picklists(self) -> bool:
        return True

    @property
    def picklist_only(self) -> bool:
        return self.role == ROLE_PICKLIST

    def to_doc(self) -> dict[str, Any]:
        return {
            "scouter_id": self.scout_id,
            "password_hash": self.password_hash,
            "active": self.active,
            "deleted": self.deleted,
            "name_confirmed": self.name_confirmed,
            "auth_revision": self.auth_revision,
            "s_number": self.s_number,
            "display_name": self.display_name,
            "role": self.role,
            # Written alongside role so an older build, or a human reading the
            # console, still sees who is privileged.
            "is_admin": self.is_admin,
            "last_login": as_utc(self.last_seen),
            "bucks": _int(self.bucks),
            "matches_scouted": _int(self.matches_scouted),
            "created_at": as_utc(self.created_at),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "Scouter":
        return cls(
            scout_id=d.get("scouter_id") or doc_id,
            password_hash=d.get("password_hash") or "",
            active=d.get("active", True),
            deleted=d.get("deleted", False),
            name_confirmed=d.get("name_confirmed", False),
            auth_revision=_int(d.get("auth_revision")),
            s_number=d.get("s_number"),
            display_name=d.get("display_name") or "",
            role=normalize_role(d.get("role"), is_admin=bool(d.get("is_admin"))),
            last_seen=as_utc(d.get("last_login")) or _now(),
            bucks=_int(d.get("bucks"), 100),
            matches_scouted=_int(d.get("matches_scouted")),
            created_at=as_utc(d.get("created_at")) or _now(),
        )


# --------------------------------------------------------------------------- #
# events                                                                       #
# --------------------------------------------------------------------------- #
@dataclass
class Event:
    """``events``: document ID is the TBA ``event_key`` (e.g. 2026txman)."""

    event_key: str
    start_date: Optional[date] = None
    name: str = ""

    COLLECTION = schema.EVENTS

    @property
    def doc_id(self) -> str:
        return self.event_key

    def to_doc(self) -> dict[str, Any]:
        start = self.start_date
        return {
            "event_key": self.event_key,
            # Firestore has no date type: store midnight UTC.
            "start_date": (
                datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
                if isinstance(start, date) and not isinstance(start, datetime)
                else as_utc(start)
            ),
            "name": self.name,
            "year": _int(self.event_key[:4], 0) or None,
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "Event":
        start = as_utc(d.get("start_date"))
        return cls(
            event_key=d.get("event_key") or doc_id,
            start_date=start.date() if start else None,
            name=d.get("name") or "",
        )


# --------------------------------------------------------------------------- #
# matches                                                                      #
# --------------------------------------------------------------------------- #
@dataclass
class MatchRecord:
    """``matches``: document ID is the TBA match key (``2026txman_qm12``)."""

    match_key: str
    event_key: str
    comp_level: str = "qm"
    match_number: int = 0                 # -> match_num
    red1: Optional[int] = None
    red2: Optional[int] = None
    red3: Optional[int] = None
    blue1: Optional[int] = None
    blue2: Optional[int] = None
    blue3: Optional[int] = None
    red_score: Optional[int] = None
    blue_score: Optional[int] = None
    winner: Optional[str] = None          # red / blue / tie / None
    predicted_time: Optional[int] = None
    betting_locked: bool = False
    youtube_key: str = ""
    film_summary: str = ""
    film_events: list[dict[str, Any]] = field(default_factory=list)
    updated_at: datetime = field(default_factory=_now)

    COLLECTION = schema.MATCHES

    @property
    def doc_id(self) -> str:
        return self.match_key

    @property
    def red(self) -> list[int]:
        return [t for t in (self.red1, self.red2, self.red3) if t]

    @property
    def blue(self) -> list[int]:
        return [t for t in (self.blue1, self.blue2, self.blue3) if t]

    def set_alliances(self, red: list[int], blue: list[int]) -> None:
        self.red1, self.red2, self.red3 = (list(red) + [None, None, None])[:3]
        self.blue1, self.blue2, self.blue3 = (list(blue) + [None, None, None])[:3]

    def to_doc(self) -> dict[str, Any]:
        return {
            "match_key": self.match_key,
            "event_key": self.event_key,
            "comp_level": self.comp_level,
            "match_num": _int(self.match_number),
            "red1": self.red1, "red2": self.red2, "red3": self.red3,
            "blue1": self.blue1, "blue2": self.blue2, "blue3": self.blue3,
            "red_score": self.red_score,
            "blue_score": self.blue_score,
            "winner": self.winner,
            "predicted_time": self.predicted_time,
            "betting_locked": bool(self.betting_locked),
            "youtube_key": self.youtube_key or "",
            "film_summary": self.film_summary or "",
            "film_events": list(self.film_events or []),
            "updated_at": as_utc(self.updated_at),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "MatchRecord":
        return cls(
            match_key=d.get("match_key") or doc_id,
            event_key=d.get("event_key") or "",
            comp_level=d.get("comp_level") or "qm",
            match_number=_int(d.get("match_num")),
            red1=d.get("red1"), red2=d.get("red2"), red3=d.get("red3"),
            blue1=d.get("blue1"), blue2=d.get("blue2"), blue3=d.get("blue3"),
            red_score=d.get("red_score"),
            blue_score=d.get("blue_score"),
            winner=d.get("winner"),
            predicted_time=d.get("predicted_time"),
            betting_locked=bool(d.get("betting_locked")),
            youtube_key=d.get("youtube_key") or "",
            film_summary=d.get("film_summary") or "",
            film_events=list(d.get("film_events") or []),
            updated_at=as_utc(d.get("updated_at")) or _now(),
        )


# --------------------------------------------------------------------------- #
# match_scouting: one document per robot, per match, per scouter              #
# --------------------------------------------------------------------------- #
#: Everything the scouter observed, stored as the nested ``data`` map (the
#: schema's JSONB column). Exempt from indexing: see schema.INDEX_EXEMPT_FIELDS.
PAYLOAD_KEYS = (
    "auto_missed", "teleop_missed",
    "heatmap", "auto_leave", "auto_climb", "climb", "climb_seconds",
    "tags", "played_defense", "defense_rating", "defense_on",
    "successful_stops", "driver_skill", "speed_rating",
    "foul_count", "failure", "failure_details",
)


@dataclass
class ScoutEntry:
    """``match_scouting``: document ID **is** ``submission_uuid``.

    Using the client's UUID as the document ID is what makes offline sync
    safe: a device replaying its IndexedDB queue writes to the same document
    path, so a duplicate is physically impossible rather than merely unlikely.
    ``repo.create_scouting`` uses Firestore's ``create()`` (fails if the
    document exists) to turn a replay into a cheap, explicit "already there".
    """

    event_key: str
    match_number: int                      # -> match_num
    team_number: int                       # -> team_num
    scout_id: str                          # -> scouter_id
    submission_id: str = field(default_factory=new_submission_id)  # -> submission_uuid
    comp_level: str = "qm"
    alliance: str = "red"
    station: int = 1
    data: dict[str, Any] = field(default_factory=dict)
    no_show: bool = False
    notes: str = ""                        # -> comments
    created_at: datetime = field(default_factory=_now)             # -> submitted_at
    client_ts: Optional[datetime] = None   # -> client_timestamp
    megascout_received_at: Optional[datetime] = None
    azure_received_at: datetime = field(default_factory=_now)
    cloud_status: str = "synced"           # pending / synced / failed
    payload_hash: str = ""
    schema_version: int = 1
    server_version: int = 1
    supersedes_submission_id: Optional[str] = None
    points: float = 0.0
    id: int = field(default_factory=next_seq_id)
    #: Legacy alias the older clients still send; always equals submission_id.
    client_uuid: Optional[str] = None

    # --- provenance ---------------------------------------------------- #
    # What this report was collected under. Pinned at submission time and
    # never rewritten, so a rule change or a form edit next week cannot
    # change what this report meant when somebody actually watched the match.
    season_id: str = ""
    form_id: str = ""
    form_version: int = 0
    game_version: int = 0
    #: Answers to questions the form asked that have no column here. A form
    #: rebuilt for a new game invents its own questions.
    responses: dict[str, Any] = field(default_factory=dict)
    #: Repeated actions, the generic shape described in app/gamedef.py:
    #: ``{action, phase, object, location, result, quantity, x, y, t}``.
    actions: list[dict[str, Any]] = field(default_factory=list)

    COLLECTION = schema.MATCH_SCOUTING

    @property
    def doc_id(self) -> str:
        return self.submission_id

    @property
    def match_key(self) -> str:
        return schema.match_id(self.event_key, self.comp_level, self.match_number)

    def to_doc(self) -> dict[str, Any]:
        return {
            "submission_uuid": self.submission_id,
            "event_key": self.event_key,
            "comp_level": self.comp_level,
            "match_num": _int(self.match_number),
            "match_key": self.match_key,
            "team_num": _int(self.team_number),
            "alliance": self.alliance,
            "station": _int(self.station, 1),
            "scouter_id": self.scout_id,
            "data": dict(self.data or {}),
            "season_id": self.season_id or "",
            "form_id": self.form_id or "",
            "form_version": _int(self.form_version),
            "game_version": _int(self.game_version),
            "responses": dict(self.responses or {}),
            "actions": list(self.actions or []),
            "no_show": bool(self.no_show),
            "comments": self.notes or "",
            "submitted_at": as_utc(self.created_at),
            "client_timestamp": as_utc(self.client_ts),
            "megascout_received_at": as_utc(self.megascout_received_at),
            "azure_received_at": as_utc(self.azure_received_at),
            "cloud_status": self.cloud_status,
            "payload_hash": self.payload_hash or "",
            "schema_version": _int(self.schema_version, 1),
            "server_version": _int(self.server_version, 1),
            "supersedes_submission_uuid": self.supersedes_submission_id,
            "points": _float(self.points),
            "seq": _int(self.id),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "ScoutEntry":
        sid = d.get("submission_uuid") or doc_id
        return cls(
            submission_id=sid,
            client_uuid=sid,
            event_key=d.get("event_key") or "",
            comp_level=d.get("comp_level") or "qm",
            match_number=_int(d.get("match_num")),
            team_number=_int(d.get("team_num")),
            alliance=d.get("alliance") or "red",
            station=_int(d.get("station"), 1),
            scout_id=d.get("scouter_id") or "",
            data=dict(d.get("data") or {}),
            season_id=d.get("season_id") or "",
            form_id=d.get("form_id") or "",
            form_version=_int(d.get("form_version")),
            game_version=_int(d.get("game_version")),
            responses=dict(d.get("responses") or {}),
            actions=list(d.get("actions") or []),
            no_show=bool(d.get("no_show")),
            notes=d.get("comments") or "",
            created_at=as_utc(d.get("submitted_at")) or _now(),
            client_ts=as_utc(d.get("client_timestamp")),
            megascout_received_at=as_utc(d.get("megascout_received_at")),
            azure_received_at=as_utc(d.get("azure_received_at")) or _now(),
            cloud_status=d.get("cloud_status") or "synced",
            payload_hash=d.get("payload_hash") or "",
            schema_version=_int(d.get("schema_version"), 1),
            server_version=_int(d.get("server_version"), 1),
            supersedes_submission_id=d.get("supersedes_submission_uuid"),
            points=_float(d.get("points")),
            id=_int(d.get("seq")) or next_seq_id(),
        )

    # ---- payload accessors (analytics reads e.heatmap, e.climb, ...) --------- #
    def _d(self, key: str, default: Any = None) -> Any:
        return (self.data or {}).get(key, default)

    @property
    def heatmap(self) -> list[dict[str, Any]]:
        return [{**p, "result": "made"} for p in self._d("heatmap") or [] if isinstance(p, dict)]

    @property
    def auto_leave(self) -> bool:
        return bool(self._d("auto_leave", False))

    @property
    def auto_climb(self) -> bool:
        return bool(self._d("auto_climb", False))

    @property
    def climb(self) -> str:
        return str(self._d("climb", "none"))

    @property
    def climb_seconds(self) -> Optional[float]:
        return self._d("climb_seconds")

    @property
    def tags(self) -> list[str]:
        return self._d("tags") or []

    @property
    def played_defense(self) -> bool:
        return bool(self._d("played_defense", False))

    @property
    def defense_rating(self) -> int:
        return _int(self._d("defense_rating", 0))

    @property
    def defense_on(self) -> str:
        return str(self._d("defense_on", "") or "")

    @property
    def successful_stops(self) -> int:
        return _int(self._d("successful_stops", 0))

    @property
    def driver_skill(self) -> int:
        return _int(self._d("driver_skill", 3), 3)

    @property
    def speed_rating(self) -> int:
        return _int(self._d("speed_rating", 3), 3)

    @property
    def fouls(self) -> int:
        return _int(self._d("foul_count", 0))

    @property
    def failure(self) -> bool:
        return bool(self._d("failure", False))

    @property
    def failure_details(self) -> str:
        return str(self._d("failure_details", "") or "")

    def envelope(self) -> dict[str, Any]:
        """The standardized submission envelope (sync + JSONL recovery line)."""
        return {
            "submission_id": self.submission_id,
            "match_number": self.match_number,
            "comp_level": self.comp_level,
            "team_number": self.team_number,
            "scout_id": self.scout_id,
            "event_key": self.event_key,
            "alliance": self.alliance,
            "station": self.station,
            "data": self.data,
            "no_show": self.no_show,
            "notes": self.notes,
            "points": self.points,
            "payload_hash": self.payload_hash,
            "schema_version": self.schema_version,
            "supersedes_submission_id": self.supersedes_submission_id,
            "client_ts": iso(self.client_ts),
            "azure_received_at": iso(self.azure_received_at),
        }

    @classmethod
    def from_submission(cls, sub: dict[str, Any]) -> "ScoutEntry":
        """Split a flat submission dict (API / offline-queue shape) into
        identity fields plus the nested ``data`` payload."""
        payload = {k: sub[k] for k in PAYLOAD_KEYS if k in sub}
        payload["heatmap"] = [{**p, "result": "made"} for p in sub.get("heatmap") or [] if isinstance(p, dict)]
        if "fouls" in sub:  # API name -> schema name
            payload["foul_count"] = _int(sub.get("fouls"))
        submission_id = (
            sub.get("submission_id") or sub.get("client_uuid") or new_submission_id()
        )
        return cls(
            submission_id=submission_id,
            client_uuid=submission_id,
            client_ts=as_utc(sub.get("client_ts")),
            payload_hash=str(sub.get("payload_hash") or ""),
            schema_version=_int(sub.get("schema_version"), 1),
            supersedes_submission_id=sub.get("supersedes_submission_id") or None,
            event_key=sub["event_key"],
            comp_level=sub.get("comp_level", "qm"),
            match_number=_int(sub["match_number"]),
            team_number=_int(sub["team_number"]),
            alliance=sub.get("alliance", "red"),
            station=_int(sub.get("station", 1), 1),
            scout_id=sub["scout_id"],
            data=payload,
            no_show=bool(sub.get("no_show", False)),
            notes=sub.get("notes", "") or "",
            points=_float(sub.get("points")),
            season_id=sub.get("season_id") or "",
            form_id=sub.get("form_id") or "",
            form_version=_int(sub.get("form_version")),
            game_version=_int(sub.get("game_version")),
            responses=dict(sub.get("responses") or {}),
            actions=list(sub.get("actions") or []),
        )


# --------------------------------------------------------------------------- #
# pit_scouting                                                                 #
# --------------------------------------------------------------------------- #
@dataclass
class PitEntry:
    """``pit_scouting``: document ID ``{event_key}_{team_num}`` (one per team)."""

    event_key: str
    team_number: int
    scout_id: str = ""
    drivetrain: str = ""
    #: Free text: what kind of robot this is ("fast cycler", "defense bot",
    #: "climber"). Typed rather than picked from a list, because the useful
    #: archetypes change with the game and nobody knows them in week one.
    archetype: str = ""
    weight_lbs: Optional[float] = None
    width_in: Optional[float] = None
    length_in: Optional[float] = None
    can_climb: str = "none"
    auto_routine: str = ""
    capabilities: list[str] = field(default_factory=list)
    robot_photo: str = ""
    # Photo bytes live in separate immutable documents. Keeping only IDs here
    # avoids Firestore's 1 MiB document ceiling and stops a new photo from
    # rewriting every earlier photo.
    photo_ids: list[str] = field(default_factory=list)
    notes: str = ""
    #: Answers to fields the pit form asks that have no column here. A form
    #: built for a new game invents its own questions, and they have to be
    #: stored somewhere without a schema change per season.
    responses: dict[str, Any] = field(default_factory=dict)
    #: Which version of which form produced this report, and under which
    #: season, so it can still be read against the questions that were
    #: actually asked.
    form_id: str = ""
    form_version: int = 0
    season_id: str = ""
    updated_at: datetime = field(default_factory=_now)

    COLLECTION = schema.PIT_SCOUTING

    @property
    def doc_id(self) -> str:
        return schema.pit_id(self.event_key, self.team_number)

    def to_doc(self) -> dict[str, Any]:
        return {
            "event_key": self.event_key,
            "team_num": _int(self.team_number),
            "scouter_id": self.scout_id or "",
            "drivetrain": self.drivetrain or "",
            "archetype": self.archetype or "",
            "weight_lbs": self.weight_lbs,
            "width_in": self.width_in,
            "length_in": self.length_in,
            "can_climb": self.can_climb or "none",
            "auto_routine": self.auto_routine or "",
            "capabilities": list(self.capabilities or []),
            "robot_photo": self.robot_photo or "",
            "photo_ids": list(self.photo_ids or []),
            "notes": self.notes or "",
            "responses": dict(self.responses or {}),
            "form_id": self.form_id or "",
            "form_version": _int(self.form_version),
            "season_id": self.season_id or "",
            "updated_at": as_utc(self.updated_at),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "PitEntry":
        return cls(
            event_key=d.get("event_key") or "",
            team_number=_int(d.get("team_num")),
            scout_id=d.get("scouter_id") or "",
            drivetrain=d.get("drivetrain") or "",
            archetype=d.get("archetype") or "",
            weight_lbs=d.get("weight_lbs"),
            width_in=d.get("width_in"),
            length_in=d.get("length_in"),
            can_climb=d.get("can_climb") or "none",
            auto_routine=d.get("auto_routine") or "",
            capabilities=list(d.get("capabilities") or []),
            robot_photo=d.get("robot_photo") or "",
            photo_ids=list(d.get("photo_ids") or []),
            notes=d.get("notes") or "",
            responses=dict(d.get("responses") or {}),
            form_id=d.get("form_id") or "",
            form_version=_int(d.get("form_version")),
            season_id=d.get("season_id") or "",
            updated_at=as_utc(d.get("updated_at")) or _now(),
        )


@dataclass
class PitPhoto:
    id: str
    event_key: str
    team_number: int
    image: str
    created_at: datetime = field(default_factory=_now)

    COLLECTION = schema.PIT_PHOTOS

    @property
    def doc_id(self) -> str:
        return self.id

    def to_doc(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "event_key": self.event_key,
            "team_num": _int(self.team_number),
            "image": self.image,
            "created_at": as_utc(self.created_at),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "PitPhoto":
        return cls(
            id=d.get("id") or doc_id,
            event_key=d.get("event_key") or "",
            team_number=_int(d.get("team_num")),
            image=d.get("image") or "",
            created_at=as_utc(d.get("created_at")) or _now(),
        )


# --------------------------------------------------------------------------- #
# picklists                                                                    #
# --------------------------------------------------------------------------- #
#: Which pick a list is for. Everyone keeps one of each.
PICK_FIRST = 1
PICK_SECOND = 2

MAX_JUSTIFICATION_CHARS = 1000


@dataclass
class Picklist:
    """``picklists``.

    The schema's ``{rank}_team_number_comments`` column family becomes an
    ordered ``items`` array of ``{rank, team_num, comments}`` maps. Rank is
    the array position, so dragging a team to a new spot is one write instead
    of renumbering N columns, and ``comments`` carries the justification the
    scout typed for that specific pick.

    ``pick_round`` splits first-pick and second-pick strategy, which are
    genuinely different lists: the first pick is usually the best robot
    available, the second is whatever complements the alliance.
    """

    event_key: str
    owner_id: str
    name: str = "My Picklist"             # -> picklist_name
    is_master: bool = False
    pick_round: int = PICK_FIRST
    items: list[dict[str, Any]] = field(default_factory=list)
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)
    id: int = field(default_factory=next_seq_id)

    COLLECTION = schema.PICKLISTS

    @property
    def doc_id(self) -> str:
        return str(self.id)

    @staticmethod
    def default_name(pick_round: int, owner_label: str = "") -> str:
        which = "First Pick" if int(pick_round) == PICK_FIRST else "Second Pick"
        return f"{owner_label} {which}".strip()

    @staticmethod
    def normalize_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Stamp contiguous 1-based ranks and the schema's field names onto the
        items the client sends.

        Accepts ``team``/``team_num`` and ``note``/``comments``/
        ``justification`` so older clients keep working, and writes all of the
        aliases back so nothing downstream has to guess.
        """
        out: list[dict[str, Any]] = []
        seen: set[int] = set()
        for raw in items or []:
            team = _int(raw.get("team", raw.get("team_num")))
            if not team or team in seen:
                continue  # a team can only occupy one slot in a list
            seen.add(team)
            note = (
                raw.get("note")
                or raw.get("comments")
                or raw.get("justification")
                or ""
            )
            note = str(note)[:MAX_JUSTIFICATION_CHARS]
            out.append(
                {
                    "rank": len(out) + 1,
                    "team": team,
                    "team_num": team,
                    "tier": raw.get("tier") or "",
                    "note": note,
                    "comments": note,
                    "justification": note,
                }
            )
        return out

    def to_doc(self) -> dict[str, Any]:
        return {
            "picklist_id": _int(self.id),
            "event_key": self.event_key,
            "owner_id": self.owner_id,
            "picklist_name": self.name,
            "is_master": bool(self.is_master),
            "pick_round": _int(self.pick_round, PICK_FIRST),
            "items": self.normalize_items(self.items),
            "created_at": as_utc(self.created_at),
            "updated_at": as_utc(self.updated_at),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "Picklist":
        return cls(
            id=_int(d.get("picklist_id")) or _int(doc_id) or next_seq_id(),
            event_key=d.get("event_key") or "",
            owner_id=d.get("owner_id") or "",
            name=d.get("picklist_name") or "My Picklist",
            is_master=bool(d.get("is_master")),
            pick_round=_int(d.get("pick_round"), PICK_FIRST) or PICK_FIRST,
            items=list(d.get("items") or []),
            created_at=as_utc(d.get("created_at")) or _now(),
            updated_at=as_utc(d.get("updated_at")) or _now(),
        )


# --------------------------------------------------------------------------- #
# bets                                                                         #
# --------------------------------------------------------------------------- #
@dataclass
class Bet:
    scout_id: str                          # -> scouter_id
    event_key: str
    match_key: str
    match_number: int = 0                  # -> match_num
    comp_level: str = "qm"
    pick: str = "red"
    wager: int = 0
    win_prob: float = 0.5
    multiplier: float = 1.0
    potential_payout: int = 0
    status: str = "open"                   # open / won / lost / refunded
    payout: int = 0
    created_at: datetime = field(default_factory=_now)
    resolved_at: Optional[datetime] = None
    id: int = field(default_factory=next_seq_id)

    COLLECTION = schema.BETS

    @property
    def doc_id(self) -> str:
        return str(self.id)

    def to_doc(self) -> dict[str, Any]:
        return {
            "bet_id": _int(self.id),
            "scouter_id": self.scout_id,
            "event_key": self.event_key,
            "match_key": self.match_key,
            "match_num": _int(self.match_number),
            "comp_level": self.comp_level,
            "pick": self.pick,
            "wager": _int(self.wager),
            "win_prob": _float(self.win_prob),
            "multiplier": _float(self.multiplier),
            "potential_payout": _int(self.potential_payout),
            "status": self.status,
            "payout": _int(self.payout),
            "created_at": as_utc(self.created_at),
            "resolved_at": as_utc(self.resolved_at),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "Bet":
        return cls(
            id=_int(d.get("bet_id")) or _int(doc_id) or next_seq_id(),
            scout_id=d.get("scouter_id") or "",
            event_key=d.get("event_key") or "",
            match_key=d.get("match_key") or "",
            match_number=_int(d.get("match_num")),
            comp_level=d.get("comp_level") or "qm",
            pick=d.get("pick") or "red",
            wager=_int(d.get("wager")),
            win_prob=_float(d.get("win_prob"), 0.5),
            multiplier=_float(d.get("multiplier"), 1.0),
            potential_payout=_int(d.get("potential_payout")),
            status=d.get("status") or "open",
            payout=_int(d.get("payout")),
            created_at=as_utc(d.get("created_at")) or _now(),
            resolved_at=as_utc(d.get("resolved_at")),
        )


# --------------------------------------------------------------------------- #
# team_cache                                                                   #
# --------------------------------------------------------------------------- #
@dataclass
class TeamCache:
    """``team_cache``: document ID is the team number as a string.

    ``avatar`` holds a base64 data URI from TBA (tens of KB) and is exempt
    from indexing; the whole document still has to stay under 1 MiB, which
    ``repo.save_team`` checks.
    """

    team_number: int
    nickname: str = ""
    name: str = ""
    city: str = ""
    state: str = ""
    country: str = ""
    rookie_year: Optional[int] = None
    avatar: str = ""
    photos: list[str] = field(default_factory=list)
    epa: Optional[float] = None
    epa_rank: Optional[int] = None
    record: dict[str, Any] = field(default_factory=dict)
    updated_at: datetime = field(default_factory=_now)

    COLLECTION = schema.TEAM_CACHE

    @property
    def doc_id(self) -> str:
        return schema.team_id(self.team_number)

    def to_doc(self) -> dict[str, Any]:
        return {
            "team_num": _int(self.team_number),
            "nickname": self.nickname or "",
            "name": self.name or "",
            "city": self.city or "",
            "state": self.state or "",
            "country": self.country or "",
            "rookie_year": self.rookie_year,
            "avatar": self.avatar or "",
            "photos": list(self.photos or []),
            "epa": self.epa,
            "epa_rank": self.epa_rank,
            "record": dict(self.record or {}),
            "updated_at": as_utc(self.updated_at),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "TeamCache":
        return cls(
            team_number=_int(d.get("team_num")) or _int(doc_id),
            nickname=d.get("nickname") or "",
            name=d.get("name") or "",
            city=d.get("city") or "",
            state=d.get("state") or "",
            country=d.get("country") or "",
            rookie_year=d.get("rookie_year"),
            avatar=d.get("avatar") or "",
            photos=list(d.get("photos") or []),
            epa=d.get("epa"),
            epa_rank=d.get("epa_rank"),
            record=dict(d.get("record") or {}),
            updated_at=as_utc(d.get("updated_at")) or _now(),
        )


# --------------------------------------------------------------------------- #
# devices                                                                      #
# --------------------------------------------------------------------------- #
@dataclass
class Device:
    """``devices``: one document per Chromebook/tablet on the event LAN."""

    device_id: str
    role: str = "scouting"                 # scouting / admin / megascout
    vlan_port: Optional[int] = None
    last_seen_at: datetime = field(default_factory=_now)
    battery_pct: Optional[int] = None
    unsynced_count: int = 0
    scout_id: str = ""

    COLLECTION = schema.DEVICES

    @property
    def doc_id(self) -> str:
        return self.device_id

    def to_doc(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "role": self.role or "scouting",
            "vlan_port": self.vlan_port,
            "last_seen_at": as_utc(self.last_seen_at),
            "battery_pct": self.battery_pct,
            "unsynced_count": _int(self.unsynced_count),
            "scouter_id": self.scout_id or "",
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "Device":
        return cls(
            device_id=d.get("device_id") or doc_id,
            role=d.get("role") or "scouting",
            vlan_port=d.get("vlan_port"),
            last_seen_at=as_utc(d.get("last_seen_at")) or _now(),
            battery_pct=d.get("battery_pct"),
            unsynced_count=_int(d.get("unsynced_count")),
            scout_id=d.get("scouter_id") or "",
        )


# --------------------------------------------------------------------------- #
# network_status                                                               #
# --------------------------------------------------------------------------- #
@dataclass
class NetworkStatus:
    """``network_status``: a periodic snapshot of the venue uplink.

    Written at most once a minute (see ``repo.record_network_status``): the
    admin panel reads the live value from memory, so this collection exists
    for after-the-fact diagnosis, not for the UI's hot path.
    """

    recorded_at: datetime = field(default_factory=_now)
    active_carrier: str = ""
    signal_quality: Optional[int] = None
    packet_loss: Optional[float] = None
    firestore_status: str = ""
    unsynced_count: Optional[int] = None
    oldest_queued_submission_uuid: Optional[str] = None
    id: int = field(default_factory=next_seq_id)

    COLLECTION = schema.NETWORK_STATUS

    @property
    def doc_id(self) -> str:
        return str(self.id)

    def to_doc(self) -> dict[str, Any]:
        return {
            "status_id": _int(self.id),
            "recorded_at": as_utc(self.recorded_at),
            "active_carrier": self.active_carrier or "",
            "signal_quality": self.signal_quality,
            "packet_loss": self.packet_loss,
            # The schema calls this postgres_status; the store is Firestore now.
            "firestore_status": self.firestore_status or "",
            "unsynced_count": self.unsynced_count,
            "oldest_queued_submission_uuid": self.oldest_queued_submission_uuid,
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "NetworkStatus":
        return cls(
            id=_int(d.get("status_id")) or _int(doc_id) or next_seq_id(),
            recorded_at=as_utc(d.get("recorded_at")) or _now(),
            active_carrier=d.get("active_carrier") or "",
            signal_quality=d.get("signal_quality"),
            packet_loss=d.get("packet_loss"),
            firestore_status=d.get("firestore_status") or "",
            unsynced_count=d.get("unsynced_count"),
            oldest_queued_submission_uuid=d.get("oldest_queued_submission_uuid"),
        )


# --------------------------------------------------------------------------- #
# sync_outbox                                                                  #
# --------------------------------------------------------------------------- #
@dataclass
class OutboxRecord:
    """``sync_outbox``: the *server-side tail* of the device outbox.

    The live outbox lives in each device's IndexedDB (``frontend/src/lib/db.ts``);
    mirroring every queued row to Firestore would cost a write per state
    transition per submission for no benefit. Only terminal failures: records
    a device gave up on: are written here, so a lead scout can find them
    after the event without the queue itself costing quota.
    """

    submission_id: str                     # -> submission_uuid
    status: str = "failed"                 # pending / sent / acknowledged / failed
    attempt_count: int = 0
    last_attempt_at: Optional[datetime] = None
    acknowledged_at: Optional[datetime] = None
    created_at: datetime = field(default_factory=_now)
    device_id: str = ""
    error: str = ""

    COLLECTION = schema.SYNC_OUTBOX

    @property
    def doc_id(self) -> str:
        return self.submission_id

    def to_doc(self) -> dict[str, Any]:
        return {
            "submission_uuid": self.submission_id,
            "status": self.status,
            "attempt_count": _int(self.attempt_count),
            "last_attempt_at": as_utc(self.last_attempt_at),
            "acknowledged_at": as_utc(self.acknowledged_at),
            "created_at": as_utc(self.created_at),
            "device_id": self.device_id or "",
            "error": (self.error or "")[:500],
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "OutboxRecord":
        return cls(
            submission_id=d.get("submission_uuid") or doc_id,
            status=d.get("status") or "failed",
            attempt_count=_int(d.get("attempt_count")),
            last_attempt_at=as_utc(d.get("last_attempt_at")),
            acknowledged_at=as_utc(d.get("acknowledged_at")),
            created_at=as_utc(d.get("created_at")) or _now(),
            device_id=d.get("device_id") or "",
            error=d.get("error") or "",
        )


#: collection name -> model class, used by the cache to hydrate snapshots.
# --------------------------------------------------------------------------- #
# event_archives                                                               #
# --------------------------------------------------------------------------- #
@dataclass
class EventArchive:
    """``event_archives``: one finished event rolled up, document ID is the key.

    Written when an event ends (see app/archive.py). It keeps the cheap summary
    fields first, plus raw snapshots needed for read-only historical review.
    """

    event_key: str
    name: str = ""
    season: int = 0
    game_name: str = ""
    archived_at: datetime = field(default_factory=_now)
    counts: dict[str, Any] = field(default_factory=dict)
    #: ``{team number as string: team_summary(...)}``
    teams: dict[str, Any] = field(default_factory=dict)
    pit: list[dict[str, Any]] = field(default_factory=list)
    picklists: list[dict[str, Any]] = field(default_factory=list)
    event: dict[str, Any] = field(default_factory=dict)
    matches: list[dict[str, Any]] = field(default_factory=list)
    scouting: list[dict[str, Any]] = field(default_factory=list)
    pit_raw: list[dict[str, Any]] = field(default_factory=list)
    picklists_raw: list[dict[str, Any]] = field(default_factory=list)
    bets: list[dict[str, Any]] = field(default_factory=list)
    team_cache: list[dict[str, Any]] = field(default_factory=list)
    analytics: dict[str, Any] = field(default_factory=dict)
    chunk_ids: list[str] = field(default_factory=list)

    COLLECTION = schema.EVENT_ARCHIVES

    @property
    def doc_id(self) -> str:
        return self.event_key

    def to_doc(self) -> dict[str, Any]:
        return {
            "event_key": self.event_key,
            "name": self.name or "",
            "season": _int(self.season),
            "game_name": self.game_name or "",
            "archived_at": as_utc(self.archived_at),
            "counts": dict(self.counts or {}),
            "teams": dict(self.teams or {}),
            "pit": list(self.pit or []),
            "picklists": list(self.picklists or []),
            "event": dict(self.event or {}),
            "matches": list(self.matches or []),
            "scouting": list(self.scouting or []),
            "pit_raw": list(self.pit_raw or []),
            "picklists_raw": list(self.picklists_raw or []),
            "bets": list(self.bets or []),
            "team_cache": list(self.team_cache or []),
            "analytics": dict(self.analytics or {}),
            "chunk_ids": list(self.chunk_ids or []),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "EventArchive":
        return cls(
            event_key=d.get("event_key") or doc_id,
            name=d.get("name") or "",
            season=_int(d.get("season")),
            game_name=d.get("game_name") or "",
            archived_at=as_utc(d.get("archived_at")) or _now(),
            counts=dict(d.get("counts") or {}),
            teams=dict(d.get("teams") or {}),
            pit=list(d.get("pit") or []),
            picklists=list(d.get("picklists") or []),
            event=dict(d.get("event") or {}),
            matches=list(d.get("matches") or []),
            scouting=list(d.get("scouting") or []),
            pit_raw=list(d.get("pit_raw") or []),
            picklists_raw=list(d.get("picklists_raw") or []),
            bets=list(d.get("bets") or []),
            team_cache=list(d.get("team_cache") or []),
            analytics=dict(d.get("analytics") or {}),
            chunk_ids=list(d.get("chunk_ids") or []),
        )


@dataclass
class EventArchiveChunk:
    """``event_archive_chunks``: large read-only payloads for one archive."""

    archive_id: str
    event_key: str
    kind: str
    index: int = 0
    data: Any = field(default_factory=dict)

    COLLECTION = schema.EVENT_ARCHIVE_CHUNKS

    @property
    def doc_id(self) -> str:
        return self.archive_id

    def to_doc(self) -> dict[str, Any]:
        return {
            "archive_id": self.archive_id,
            "event_key": self.event_key,
            "kind": self.kind,
            "index": _int(self.index),
            "data": self.data,
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "EventArchiveChunk":
        return cls(
            archive_id=d.get("archive_id") or doc_id,
            event_key=d.get("event_key") or "",
            kind=d.get("kind") or "",
            index=_int(d.get("index")),
            data=d.get("data"),
        )


# --------------------------------------------------------------------------- #
# seasons + season_revisions                                                   #
# --------------------------------------------------------------------------- #
#: A season being built, in play, or finished. The status is what stops an
#: admin configuring next year's game into this year's live event.
SEASON_SETUP = "setup"
SEASON_ACTIVE = "active"
SEASON_ARCHIVED = "archived"
SEASON_STATUSES = (SEASON_SETUP, SEASON_ACTIVE, SEASON_ARCHIVED)


@dataclass
class Season:
    """``seasons``: one FRC season. Document ID is ``season_id``.

    A season owns its game definition, its forms, its events and everything
    scouted under them. It is the boundary that keeps 2026 data meaning what
    it meant in 2026 after the 2027 game lands.

    The definition is stored inline because it is small, read on nearly every
    request, and always wanted whole. Its history lives in
    ``season_revisions``, the same append-only shape forms use.
    """

    season_id: str
    year: int = 0
    game_name: str = ""
    status: str = SEASON_SETUP
    #: The generic game definition (see app/gamedef.py) as a plain dict.
    definition: dict[str, Any] = field(default_factory=dict)
    #: Bumped on every saved change, and pinned onto every submission so a
    #: scoring change cannot rewrite history.
    game_version: int = 0
    #: Which season the game configuration was copied from, if any.
    copied_from: str = ""
    notes: str = ""
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)
    updated_by: str = ""

    COLLECTION = schema.SEASONS

    @property
    def doc_id(self) -> str:
        return self.season_id

    @property
    def is_archived(self) -> bool:
        return self.status == SEASON_ARCHIVED

    def to_doc(self) -> dict[str, Any]:
        return {
            "season_id": self.season_id,
            "year": _int(self.year),
            "game_name": self.game_name or "",
            "status": self.status or SEASON_SETUP,
            "definition": dict(self.definition or {}),
            "game_version": _int(self.game_version),
            "copied_from": self.copied_from or "",
            "notes": self.notes or "",
            "created_at": as_utc(self.created_at),
            "updated_at": as_utc(self.updated_at),
            "updated_by": self.updated_by or "",
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "Season":
        return cls(
            season_id=d.get("season_id") or doc_id,
            year=_int(d.get("year")),
            game_name=d.get("game_name") or "",
            status=d.get("status") or SEASON_SETUP,
            definition=dict(d.get("definition") or {}),
            game_version=_int(d.get("game_version")),
            copied_from=d.get("copied_from") or "",
            notes=d.get("notes") or "",
            created_at=as_utc(d.get("created_at")) or _now(),
            updated_at=as_utc(d.get("updated_at")) or _now(),
            updated_by=d.get("updated_by") or "",
        )


@dataclass
class SeasonRevision:
    """``season_revisions``: one immutable version of a game definition.

    Exactly the contract form revisions have, for the same reason: a scoring
    change must never reach backwards. A submission records the game version
    it was collected under, and that version can always be read back.

    Document ID is ``{season_id}@{version}``.
    """

    season_id: str
    version: int
    definition: dict[str, Any] = field(default_factory=dict)
    parent_version: int = 0
    message: str = ""
    author_id: str = ""
    author_name: str = ""
    created_at: datetime = field(default_factory=_now)
    reverted_from: int = 0
    summary: str = ""

    COLLECTION = schema.SEASON_REVISIONS

    @property
    def doc_id(self) -> str:
        return f"{self.season_id}@{int(self.version):06d}"

    def to_doc(self) -> dict[str, Any]:
        return {
            "season_id": self.season_id,
            "version": _int(self.version),
            "definition": dict(self.definition or {}),
            "parent_version": _int(self.parent_version),
            "message": self.message or "",
            "author_id": self.author_id or "",
            "author_name": self.author_name or "",
            "created_at": as_utc(self.created_at),
            "reverted_from": _int(self.reverted_from),
            "summary": self.summary or "",
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "SeasonRevision":
        return cls(
            season_id=d.get("season_id") or doc_id.split("@")[0],
            version=_int(d.get("version")),
            definition=dict(d.get("definition") or {}),
            parent_version=_int(d.get("parent_version")),
            message=d.get("message") or "",
            author_id=d.get("author_id") or "",
            author_name=d.get("author_name") or "",
            created_at=as_utc(d.get("created_at")) or _now(),
            reverted_from=_int(d.get("reverted_from")),
            summary=d.get("summary") or "",
        )


# --------------------------------------------------------------------------- #
# forms + form_revisions                                                       #
# --------------------------------------------------------------------------- #
@dataclass
class Form:
    """``forms``: the current state of one form. Document ID is ``form_id``.

    Deliberately thin. This is a pointer plus metadata; the definitions
    themselves live in ``form_revisions`` and are never edited in place, so
    this document changes only when a different version is published.
    """

    form_id: str
    kind: str = "custom"
    name: str = ""
    description: str = ""
    #: The season this form was built for. Scouting a 2027 event must not
    #: hand somebody a form designed around the 2026 game.
    season_id: str = ""
    #: The revision scouts are currently filling in.
    published_version: int = 0
    #: The highest revision written, published or not.
    latest_version: int = 0
    #: Soft delete. Archived forms keep their whole history and can be
    #: restored, because deleting a season of form design to fix a mistake is
    #: not a recoverable action.
    archived: bool = False
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)
    updated_by: str = ""

    COLLECTION = schema.FORMS

    @property
    def doc_id(self) -> str:
        return self.form_id

    def to_doc(self) -> dict[str, Any]:
        return {
            "form_id": self.form_id,
            "kind": self.kind or "custom",
            "name": self.name or self.form_id,
            "description": self.description or "",
            "season_id": self.season_id or "",
            "published_version": _int(self.published_version),
            "latest_version": _int(self.latest_version),
            "archived": bool(self.archived),
            "created_at": as_utc(self.created_at),
            "updated_at": as_utc(self.updated_at),
            "updated_by": self.updated_by or "",
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "Form":
        return cls(
            form_id=d.get("form_id") or doc_id,
            kind=d.get("kind") or "custom",
            name=d.get("name") or doc_id,
            description=d.get("description") or "",
            season_id=d.get("season_id") or "",
            published_version=_int(d.get("published_version")),
            latest_version=_int(d.get("latest_version")),
            archived=bool(d.get("archived")),
            created_at=as_utc(d.get("created_at")) or _now(),
            updated_at=as_utc(d.get("updated_at")) or _now(),
            updated_by=d.get("updated_by") or "",
        )


@dataclass
class FormRevision:
    """``form_revisions``: one immutable version of a form.

    Append-only, like a commit. Editing a form writes a new revision with the
    author, a message and a pointer to what it came from; nothing ever
    overwrites a revision. Reverting writes another revision whose definition
    is a copy of an older one, so the history stays a straight line and the
    fact that a revert happened is itself recorded.

    Document ID is ``{form_id}@{version}``, which sorts naturally and makes a
    single revision fetchable without a query.
    """

    form_id: str
    version: int
    definition: dict[str, Any] = field(default_factory=dict)
    #: What this revision came from. 0 for the first.
    parent_version: int = 0
    #: Why. Free text the author typed, like a commit message.
    message: str = ""
    author_id: str = ""
    author_name: str = ""
    created_at: datetime = field(default_factory=_now)
    #: Set when this revision was made by reverting to an older one.
    reverted_from: int = 0
    #: A one-line summary of what changed against the parent, computed at
    #: write time so the history list needs no diffing to render.
    summary: str = ""

    COLLECTION = schema.FORM_REVISIONS

    @property
    def doc_id(self) -> str:
        return f"{self.form_id}@{int(self.version):06d}"

    def to_doc(self) -> dict[str, Any]:
        return {
            "form_id": self.form_id,
            "version": _int(self.version),
            "definition": dict(self.definition or {}),
            "parent_version": _int(self.parent_version),
            "message": self.message or "",
            "author_id": self.author_id or "",
            "author_name": self.author_name or "",
            "created_at": as_utc(self.created_at),
            "reverted_from": _int(self.reverted_from),
            "summary": self.summary or "",
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "FormRevision":
        return cls(
            form_id=d.get("form_id") or doc_id.split("@")[0],
            version=_int(d.get("version")),
            definition=dict(d.get("definition") or {}),
            parent_version=_int(d.get("parent_version")),
            message=d.get("message") or "",
            author_id=d.get("author_id") or "",
            author_name=d.get("author_name") or "",
            created_at=as_utc(d.get("created_at")) or _now(),
            reverted_from=_int(d.get("reverted_from")),
            summary=d.get("summary") or "",
        )


@dataclass
class PicklistDocument:
    """Raw versioned documents; picklist_service owns their bounded read cache."""
    id: str
    data: dict[str, Any] = field(default_factory=dict)
    COLLECTION: ClassVar[str] = schema.PICKLIST_RECORDS

    @property
    def doc_id(self) -> str:
        return self.id

    def to_doc(self) -> dict[str, Any]:
        from copy import deepcopy
        return deepcopy(self.data)

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]):
        from copy import deepcopy
        return cls(id=doc_id, data=deepcopy(d))


class PicklistWorkspaceDocument(PicklistDocument):
    COLLECTION = schema.PICKLIST_WORKSPACES


class PicklistHistoryDocument(PicklistDocument):
    COLLECTION = schema.PICKLIST_HISTORY


class AccountAuditDocument(PicklistDocument):
    COLLECTION = schema.ACCOUNT_AUDIT


@dataclass
class ScoutingAuditDocument(PicklistDocument):
    """Immutable admin action applied over an original scouting submission."""
    event_key: str = ""
    COLLECTION: ClassVar[str] = schema.SCOUTING_AUDIT

    def to_doc(self) -> dict[str, Any]:
        return {**super().to_doc(), "event_key": self.event_key}

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]):
        return cls(id=doc_id, event_key=d.get("event_key") or "", data=dict(d))


MODEL_FOR_COLLECTION = {
    schema.ACCOUNT_AUDIT: AccountAuditDocument,
    schema.SCOUTERS: Scouter,
    schema.EVENTS: Event,
    schema.MATCHES: MatchRecord,
    schema.MATCH_SCOUTING: ScoutEntry,
    schema.SCOUTING_AUDIT: ScoutingAuditDocument,
    schema.PICKLISTS: Picklist,
    schema.PICKLIST_RECORDS: PicklistDocument,
    schema.PICKLIST_WORKSPACES: PicklistWorkspaceDocument,
    schema.PICKLIST_HISTORY: PicklistHistoryDocument,
    schema.BETS: Bet,
    schema.PIT_SCOUTING: PitEntry,
    schema.PIT_PHOTOS: PitPhoto,
    schema.TEAM_CACHE: TeamCache,
    schema.DEVICES: Device,
    schema.NETWORK_STATUS: NetworkStatus,
    schema.SYNC_OUTBOX: OutboxRecord,
    schema.EVENT_ARCHIVES: EventArchive,
    schema.EVENT_ARCHIVE_CHUNKS: EventArchiveChunk,
    schema.FORMS: Form,
    schema.FORM_REVISIONS: FormRevision,
    schema.SEASONS: Season,
    schema.SEASON_REVISIONS: SeasonRevision,
}
