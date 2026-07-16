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
    client_uuid: Optional[str] = Field(default=None, index=True)

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

    @classmethod
    def from_submission(cls, sub: dict[str, Any]) -> "ScoutEntry":
        """Split a flat submission dict (the API/offline-queue shape) into
        identity columns + the ``data`` payload."""
        payload = {k: sub[k] for k in _PAYLOAD_KEYS if k in sub}
        if "fouls" in sub:  # API name → schema name
            payload["foul_count"] = int(sub["fouls"] or 0)
        return cls(
            client_uuid=sub.get("client_uuid"),
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
