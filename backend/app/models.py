"""Firestore document models for HazeHub.

Every class here is a plain dataclass that knows how to convert itself to and
from a Firestore document. There is no ORM and no session: ``repo.py`` reads
from the in-memory mirror in ``cache.py`` and writes through to Firestore.

Two naming systems meet in this file, on purpose:

* **Document fields** use the names from the team's DB schema
  (``scouter_id``, ``match_num``, ``team_num``, ``comments``, ``submitted_at``,
  ``submission_uuid``…), so what is stored in Firestore matches the design doc
  and any SQL export lines up column-for-column.
* **Python attributes** keep the names the rest of the codebase and the JSON
  API already use (``scout_id``, ``match_number``, ``team_number``, ``notes``,
  ``created_at``, ``submission_id``…), so analytics, routers and the frontend
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
from typing import Any, Optional

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

    ``ms * 1000 + n`` gives 1000 IDs per millisecond and lands around 1.8e15
    — under JavaScript's 2^53 safe-integer ceiling, so the frontend can keep
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
@dataclass
class Scouter:
    """``scouters`` — document ID is ``scouter_id``."""

    scout_id: str
    s_number: Optional[int] = None
    display_name: str = ""
    is_admin: bool = False
    last_seen: datetime = field(default_factory=_now)   # -> last_login
    bucks: int = 100
    matches_scouted: int = 0
    created_at: datetime = field(default_factory=_now)

    COLLECTION = schema.SCOUTERS

    @property
    def doc_id(self) -> str:
        return self.scout_id

    def to_doc(self) -> dict[str, Any]:
        return {
            "scouter_id": self.scout_id,
            "s_number": self.s_number,
            "display_name": self.display_name,
            "is_admin": bool(self.is_admin),
            "last_login": as_utc(self.last_seen),
            "bucks": _int(self.bucks),
            "matches_scouted": _int(self.matches_scouted),
            "created_at": as_utc(self.created_at),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "Scouter":
        return cls(
            scout_id=d.get("scouter_id") or doc_id,
            s_number=d.get("s_number"),
            display_name=d.get("display_name") or "",
            is_admin=bool(d.get("is_admin")),
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
    """``events`` — document ID is the TBA ``event_key`` (e.g. 2026txman)."""

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
            # Firestore has no date type — store midnight UTC.
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
    """``matches`` — document ID is the TBA match key (``2026txman_qm12``)."""

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
# match_scouting — one document per robot, per match, per scouter              #
# --------------------------------------------------------------------------- #
#: Everything the scouter observed, stored as the nested ``data`` map (the
#: schema's JSONB column). Exempt from indexing — see schema.INDEX_EXEMPT_FIELDS.
PAYLOAD_KEYS = (
    "heatmap", "auto_leave", "auto_climb", "climb", "climb_seconds",
    "tags", "played_defense", "defense_rating", "defense_on",
    "successful_stops", "driver_skill", "speed_rating",
    "foul_count", "failure", "failure_details",
)


@dataclass
class ScoutEntry:
    """``match_scouting`` — document ID **is** ``submission_uuid``.

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

    # ---- payload accessors (analytics reads e.heatmap, e.climb, …) --------- #
    def _d(self, key: str, default: Any = None) -> Any:
        return (self.data or {}).get(key, default)

    @property
    def heatmap(self) -> list[dict[str, Any]]:
        return self._d("heatmap") or []

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
        )


# --------------------------------------------------------------------------- #
# pit_scouting                                                                 #
# --------------------------------------------------------------------------- #
@dataclass
class PitEntry:
    """``pit_scouting`` — document ID ``{event_key}_{team_num}`` (one per team)."""

    event_key: str
    team_number: int
    scout_id: str = ""
    drivetrain: str = ""
    weight_lbs: Optional[float] = None
    width_in: Optional[float] = None
    length_in: Optional[float] = None
    can_climb: str = "none"
    auto_routine: str = ""
    capabilities: list[str] = field(default_factory=list)
    robot_photo: str = ""
    notes: str = ""
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
            "weight_lbs": self.weight_lbs,
            "width_in": self.width_in,
            "length_in": self.length_in,
            "can_climb": self.can_climb or "none",
            "auto_routine": self.auto_routine or "",
            "capabilities": list(self.capabilities or []),
            "robot_photo": self.robot_photo or "",
            "notes": self.notes or "",
            "updated_at": as_utc(self.updated_at),
        }

    @classmethod
    def from_doc(cls, doc_id: str, d: dict[str, Any]) -> "PitEntry":
        return cls(
            event_key=d.get("event_key") or "",
            team_number=_int(d.get("team_num")),
            scout_id=d.get("scouter_id") or "",
            drivetrain=d.get("drivetrain") or "",
            weight_lbs=d.get("weight_lbs"),
            width_in=d.get("width_in"),
            length_in=d.get("length_in"),
            can_climb=d.get("can_climb") or "none",
            auto_routine=d.get("auto_routine") or "",
            capabilities=list(d.get("capabilities") or []),
            robot_photo=d.get("robot_photo") or "",
            notes=d.get("notes") or "",
            updated_at=as_utc(d.get("updated_at")) or _now(),
        )


# --------------------------------------------------------------------------- #
# picklists                                                                    #
# --------------------------------------------------------------------------- #
@dataclass
class Picklist:
    """``picklists``.

    The schema's ``{rank}_team_number_comments`` column family becomes an
    ordered ``items`` array of ``{rank, team_num, comments, tier}`` maps —
    rank is the array position, so the list can be reordered with one write
    instead of N column updates.
    """

    event_key: str
    owner_id: str
    name: str = "My Picklist"             # -> picklist_name
    is_master: bool = False
    items: list[dict[str, Any]] = field(default_factory=list)
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)
    id: int = field(default_factory=next_seq_id)

    COLLECTION = schema.PICKLISTS

    @property
    def doc_id(self) -> str:
        return str(self.id)

    @staticmethod
    def normalize_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Stamp contiguous 1-based ranks and the schema's field names onto the
        items the client sends (``{team, tier, note}``)."""
        out: list[dict[str, Any]] = []
        for i, raw in enumerate(items or [], 1):
            team = raw.get("team", raw.get("team_num"))
            out.append(
                {
                    "rank": i,
                    "team": _int(team),
                    "team_num": _int(team),
                    "tier": raw.get("tier") or "",
                    "note": raw.get("note", raw.get("comments", "")) or "",
                    "comments": raw.get("note", raw.get("comments", "")) or "",
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
    """``team_cache`` — document ID is the team number as a string.

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
    """``devices`` — one document per Chromebook/tablet on the event LAN."""

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
    """``network_status`` — a periodic snapshot of the venue uplink.

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
    """``sync_outbox`` — the *server-side tail* of the device outbox.

    The live outbox lives in each device's IndexedDB (``frontend/src/lib/db.ts``);
    mirroring every queued row to Firestore would cost a write per state
    transition per submission for no benefit. Only terminal failures — records
    a device gave up on — are written here, so a lead scout can find them
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
MODEL_FOR_COLLECTION = {
    schema.SCOUTERS: Scouter,
    schema.EVENTS: Event,
    schema.MATCHES: MatchRecord,
    schema.MATCH_SCOUTING: ScoutEntry,
    schema.PICKLISTS: Picklist,
    schema.BETS: Bet,
    schema.PIT_SCOUTING: PitEntry,
    schema.TEAM_CACHE: TeamCache,
    schema.DEVICES: Device,
    schema.NETWORK_STATUS: NetworkStatus,
    schema.SYNC_OUTBOX: OutboxRecord,
}
