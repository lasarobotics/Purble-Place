"""SQLModel tables for HazeHub.

Schema (matches the 2027 design doc)
------------------------------------
* ``scouters``       — scouter_id PK, s_number unique, display_name, is_admin,
                       last_login (+ app columns: bucks, matches_scouted).
* ``events``         — event_key PK (TBA format), start_date.
* ``matches``        — event_key, comp_level, match_num, red1..red3,
                       blue1..blue3 (+ app columns: scores, betting, film).
* ``match_scouting`` — one row per robot per match per scouter: identity
                       columns + a ``data`` JSON payload holding the scouting
                       observations (heatmap, climb, ratings, tags,
                       foul_count, …), ``no_show``, ``comments``,
                       ``submitted_at``.

Python attribute names stay stable (``match_number``, ``scout_id``,
``created_at``…) and map onto the schema's column names via ``sa_column`` so
the rest of the codebase — and the frontend API contract — is unchanged.
JSON columns use SQLAlchemy's portable ``JSON`` type, which lands as JSONB-ish
TEXT on SQLite and native JSONB-compatible JSON on Azure PostgreSQL.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_submission_id() -> str:
    return str(uuid.uuid4())


def _parse_ts(value: Any) -> Optional[datetime]:
    """Parse a client-supplied ISO timestamp; tolerate junk and trailing 'Z'."""
    if isinstance(value, datetime):
        return value
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# scouters                                                                     #
# --------------------------------------------------------------------------- #
class Scouter(SQLModel, table=True):
    __tablename__ = "scouters"

    scout_id: str = Field(sa_column=Column("scouter_id", String, primary_key=True))
    s_number: Optional[int] = Field(
        default=None, sa_column=Column("s_number", Integer, unique=True)
    )
    display_name: str = ""
    is_admin: bool = Field(default=False, sa_column=Column("is_admin", Boolean, nullable=False))
    last_seen: datetime = Field(
        default_factory=_now, sa_column=Column("last_login", DateTime(timezone=True))
    )
    # App extras (Purple Bucks economy + activity counter).
    bucks: int = 100
    matches_scouted: int = 0
    created_at: datetime = Field(default_factory=_now)


# --------------------------------------------------------------------------- #
# events                                                                       #
# --------------------------------------------------------------------------- #
class Event(SQLModel, table=True):
    __tablename__ = "events"

    event_key: str = Field(primary_key=True)  # TBA format, e.g. 2027txaus
    start_date: Optional[date] = None
    name: str = ""  # app extra — display name from TBA


# --------------------------------------------------------------------------- #
# match_scouting — one row per robot, per match, per scouter                   #
# --------------------------------------------------------------------------- #
# Keys inside the ``data`` payload (everything the scouter observed).
_PAYLOAD_KEYS = (
    "heatmap", "auto_leave", "auto_climb", "climb", "climb_seconds",
    "tags", "played_defense", "defense_rating", "defense_on",
    "successful_stops", "driver_skill", "speed_rating",
    "foul_count", "failure", "failure_details",
)


class ScoutEntry(SQLModel, table=True):
    __tablename__ = "match_scouting"
    __table_args__ = (
        UniqueConstraint("client_uuid", name="uq_scout_client_uuid"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    # Idempotency key from the client (so offline re-sync can't duplicate).
    # ``client_uuid`` is the legacy name; ``submission_id`` is the canonical
    # UUID the MegaScout design assigns to every submission and carries all the
    # way through to Azure. They are the same value.
    client_uuid: Optional[str] = Field(default=None, index=True)
    submission_id: str = Field(default_factory=_new_submission_id, index=True)

    event_key: str = Field(index=True)
    comp_level: str = "qm"            # qm / qf / sf / f
    match_number: int = Field(sa_column=Column("match_num", Integer, nullable=False, index=True))
    team_number: int = Field(sa_column=Column("team_num", Integer, nullable=False, index=True))
    alliance: str = "red"             # red / blue
    station: int = 1                  # 1..3
    scout_id: str = Field(sa_column=Column("scouter_id", String, index=True))

    # The scouting payload — heatmap attempts, climb, ratings, tags,
    # foul_count, failure details… (see _PAYLOAD_KEYS).
    data: dict[str, Any] = Field(default_factory=dict, sa_column=Column("data", JSON, nullable=False))

    no_show: bool = Field(default=False, sa_column=Column("no_show", Boolean, nullable=False))
    notes: str = Field(default="", sa_column=Column("comments", Text))
    created_at: datetime = Field(
        default_factory=_now,
        sa_column=Column("submitted_at", DateTime(timezone=True), nullable=False),
    )

    # --- MegaScout submission lifecycle (the standardized envelope) --------- #
    # client_ts             : when the device created the record (may predate
    #                         MegaScout receipt by hours if it was offline).
    # megascout_receipt_ts  : when MegaScout committed it to PostgreSQL.
    # azure_receipt_ts      : when Azure acknowledged it (set by the sync worker).
    # cloud_status          : queued / synced / failed — mirrors the outbox.
    client_ts: Optional[datetime] = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    megascout_receipt_ts: datetime = Field(default_factory=_now, sa_column=Column(DateTime(timezone=True), nullable=False))
    azure_receipt_ts: Optional[datetime] = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    cloud_status: str = Field(default="queued", index=True)  # queued / synced / failed

    # Derived scoring proxy, cached on insert so analytics stay cheap.
    points: float = Field(default=0.0, sa_column=Column("points", Float))

    # ---- payload accessors (keep analytics/routers reading e.heatmap etc.) --
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
        return int(self._d("defense_rating", 0) or 0)

    @property
    def defense_on(self) -> str:
        return str(self._d("defense_on", "") or "")

    @property
    def successful_stops(self) -> int:
        return int(self._d("successful_stops", 0) or 0)

    @property
    def driver_skill(self) -> int:
        return int(self._d("driver_skill", 3) or 3)

    @property
    def speed_rating(self) -> int:
        return int(self._d("speed_rating", 3) or 3)

    @property
    def fouls(self) -> int:
        return int(self._d("foul_count", 0) or 0)

    @property
    def failure(self) -> bool:
        return bool(self._d("failure", False))

    @property
    def failure_details(self) -> str:
        return str(self._d("failure_details", "") or "")

    def envelope(self) -> dict[str, Any]:
        """The standardized submission envelope shipped to Azure.

        Exactly the fields the MegaScout design fixes as the sync contract:
        submission id, identity, and the three lifecycle timestamps + status.
        """
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
            "client_ts": self.client_ts.isoformat() if self.client_ts else None,
            "megascout_receipt_ts": self.megascout_receipt_ts.isoformat()
            if self.megascout_receipt_ts
            else None,
        }

    @classmethod
    def from_submission(cls, sub: dict[str, Any]) -> "ScoutEntry":
        """Split a flat submission dict (the API/offline-queue shape) into
        identity columns + the ``data`` payload."""
        payload = {k: sub[k] for k in _PAYLOAD_KEYS if k in sub}
        if "fouls" in sub:  # API name → schema name
            payload["foul_count"] = int(sub["fouls"] or 0)
        # The client's UUID is the submission id; generate one if the client
        # (an older build) didn't send it.
        submission_id = sub.get("submission_id") or sub.get("client_uuid") or _new_submission_id()
        client_ts = _parse_ts(sub.get("client_ts"))
        return cls(
            client_uuid=sub.get("client_uuid") or submission_id,
            submission_id=submission_id,
            client_ts=client_ts,
            event_key=sub["event_key"],
            comp_level=sub.get("comp_level", "qm"),
            match_number=int(sub["match_number"]),
            team_number=int(sub["team_number"]),
            alliance=sub.get("alliance", "red"),
            station=int(sub.get("station", 1)),
            scout_id=sub["scout_id"],
            data=payload,
            no_show=bool(sub.get("no_show", False)),
            notes=sub.get("notes", "") or "",
            points=float(sub.get("points", 0.0)),
        )


class PitEntry(SQLModel, table=True):
    __table_args__ = (
        UniqueConstraint("event_key", "team_number", name="uq_pit_team"),
    )
    id: Optional[int] = Field(default=None, primary_key=True)
    event_key: str = Field(index=True)
    team_number: int = Field(index=True)
    scout_id: str = ""
    drivetrain: str = ""
    weight_lbs: Optional[float] = None
    width_in: Optional[float] = None
    length_in: Optional[float] = None
    can_climb: str = "none"           # none / l1 / l2 / l3
    auto_routine: str = ""
    capabilities: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    robot_photo: str = ""             # data URI or URL captured in the pit
    notes: str = ""
    updated_at: datetime = Field(default_factory=_now)


# --------------------------------------------------------------------------- #
# Picklists (multiplayer)                                                      #
# --------------------------------------------------------------------------- #
class Picklist(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    event_key: str = Field(index=True)
    owner_id: str = Field(index=True)
    name: str = "My Picklist"
    is_master: bool = False
    # [{ "team": int, "tier": "first"|"second"|"third"|"dnp", "note": str }]
    items: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


# --------------------------------------------------------------------------- #
# Betting                                                                      #
# --------------------------------------------------------------------------- #
class Bet(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    scout_id: str = Field(index=True)
    event_key: str = Field(index=True)
    match_key: str = Field(index=True)     # e.g. 2026xyz_qm12
    match_number: int = 0
    comp_level: str = "qm"
    pick: str = "red"                       # red / blue
    wager: int = 0
    win_prob: float = 0.5                   # prob of the picked alliance at bet time
    multiplier: float = 1.0                 # payout multiplier (incl. profit)
    potential_payout: int = 0
    status: str = "open"                    # open / won / lost / refunded
    payout: int = 0                         # actually credited on resolve
    created_at: datetime = Field(default_factory=_now)
    resolved_at: Optional[datetime] = None


# --------------------------------------------------------------------------- #
# matches — TBA schedule + betting/film state                                  #
# --------------------------------------------------------------------------- #
class MatchRecord(SQLModel, table=True):
    __tablename__ = "matches"
    __table_args__ = (
        UniqueConstraint("match_key", name="uq_match_key"),
    )
    id: Optional[int] = Field(default=None, primary_key=True)
    match_key: str = Field(index=True)      # app extra — bets key off this
    event_key: str = Field(index=True)
    comp_level: str = "qm"
    match_number: int = Field(default=0, sa_column=Column("match_num", Integer, nullable=False))
    red1: Optional[int] = None
    red2: Optional[int] = None
    red3: Optional[int] = None
    blue1: Optional[int] = None
    blue2: Optional[int] = None
    blue3: Optional[int] = None
    red_score: Optional[int] = None
    blue_score: Optional[int] = None
    winner: Optional[str] = None            # red / blue / tie / None
    predicted_time: Optional[int] = None
    # Betting state
    betting_locked: bool = False
    youtube_key: str = ""
    # Film review: a written takeaway + a timestamped play-by-play of key moments
    # [{ "time": "1:02", "team": 4414, "type": "Cycle", "detail": "..." }]
    film_summary: str = ""
    film_events: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=_now)

    @property
    def red(self) -> list[int]:
        return [t for t in (self.red1, self.red2, self.red3) if t]

    @property
    def blue(self) -> list[int]:
        return [t for t in (self.blue1, self.blue2, self.blue3) if t]

    def set_alliances(self, red: list[int], blue: list[int]) -> None:
        self.red1, self.red2, self.red3 = (list(red) + [None, None, None])[:3]
        self.blue1, self.blue2, self.blue3 = (list(blue) + [None, None, None])[:3]


class TeamCache(SQLModel, table=True):
    team_number: int = Field(primary_key=True)
    nickname: str = ""
    name: str = ""
    city: str = ""
    state: str = ""
    country: str = ""
    rookie_year: Optional[int] = None
    avatar: str = ""                        # data URI (TBA avatar)
    photos: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    epa: Optional[float] = None
    epa_rank: Optional[int] = None
    record: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=_now)


# --------------------------------------------------------------------------- #
# Key/value app settings + raw external cache                                  #
# --------------------------------------------------------------------------- #
class AppSetting(SQLModel, table=True):
    key: str = Field(primary_key=True)
    value: str = ""


class ExternalCache(SQLModel, table=True):
    url: str = Field(primary_key=True)
    payload: Any = Field(default=None, sa_column=Column(JSON))
    fetched_at: datetime = Field(default_factory=_now)


# --------------------------------------------------------------------------- #
# Transactional outbox — the MegaScout → Azure durable sync queue              #
# --------------------------------------------------------------------------- #
class OutboxRecord(SQLModel, table=True):
    """One durable "please ship this to Azure" instruction.

    Written in the SAME database transaction as the scouting record it refers
    to (see ``repositories.commit_submission``), so a record can never exist in
    PostgreSQL without also being queued for cloud sync. Rows are never deleted
    — a shipped row is marked ``sent`` and kept as an audit trail.
    """

    __tablename__ = "sync_outbox"

    id: Optional[int] = Field(default=None, primary_key=True)
    # Idempotency key — matches ScoutEntry.submission_id and the Azure record.
    submission_id: str = Field(sa_column=Column(String, unique=True, index=True, nullable=False))
    aggregate_type: str = "match_scouting"
    aggregate_id: str = ""  # ScoutEntry.id as a string, once known

    # Denormalized identity so the health panel can answer "oldest queued
    # record (with match #)" and "missing match submissions" without a join.
    event_key: str = Field(default="", index=True)
    match_number: int = 0
    team_number: int = 0
    scout_id: str = ""

    # The exact envelope POSTed to Azure.
    payload: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))

    status: str = Field(default="queued", index=True)  # queued / sent / failed
    attempts: int = 0
    last_error: str = Field(default="", sa_column=Column(Text))

    client_ts: Optional[datetime] = None
    created_at: datetime = Field(default_factory=_now, index=True)  # MegaScout receipt
    next_attempt_at: datetime = Field(default_factory=_now, index=True)
    azure_receipt_ts: Optional[datetime] = None


class WorkerHeartbeat(SQLModel, table=True):
    """Liveness + last-run stats for the Azure sync worker, for the health panel."""

    __tablename__ = "worker_heartbeat"

    name: str = Field(default="azure_sync", primary_key=True)
    last_beat: datetime = Field(default_factory=_now)
    last_synced: int = 0
    last_error: str = Field(default="", sa_column=Column(Text))
    cloud_reachable: bool = True
