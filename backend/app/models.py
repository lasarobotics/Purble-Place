"""SQLModel tables for HazeHub.

Design notes
------------
* JSON columns (heatmap points, picklist items, cached payloads) use
  SQLAlchemy's portable ``JSON`` type so the exact same models run on the
  local SQLite file and on Azure Database for PostgreSQL.
* Scouting is centred on a *heatmap* of scoring attempts (each click = one
  attempt at x/y in a phase with a result) plus qualitative ratings — this
  mirrors the "qualitative, data-driven insights" goal.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Column, UniqueConstraint
from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Accounts                                                                     #
# --------------------------------------------------------------------------- #
class Scouter(SQLModel, table=True):
    scout_id: str = Field(primary_key=True)
    display_name: str = ""
    is_admin: bool = False
    bucks: int = 100
    matches_scouted: int = 0
    created_at: datetime = Field(default_factory=_now)
    last_seen: datetime = Field(default_factory=_now)


# --------------------------------------------------------------------------- #
# Match scouting                                                               #
# --------------------------------------------------------------------------- #
class ScoutEntry(SQLModel, table=True):
    __table_args__ = (
        UniqueConstraint("client_uuid", name="uq_scout_client_uuid"),
    )
    id: Optional[int] = Field(default=None, primary_key=True)
    # Idempotency key from the client (so offline re-sync can't duplicate).
    client_uuid: Optional[str] = Field(default=None, index=True)

    event_key: str = Field(index=True)
    match_number: int = Field(index=True)
    comp_level: str = "qm"            # qm / sf / f
    team_number: int = Field(index=True)
    alliance: str = "red"             # red / blue
    station: int = 1                  # 1..3
    scout_id: str = Field(index=True)

    # Autonomous
    auto_leave: bool = False
    auto_climb: bool = False

    # Scoring attempts captured on the field heatmap.
    # [{ "x": float(0-1), "y": float(0-1), "phase": "auto"|"teleop",
    #    "result": "made"|"missed", "value": int }]
    heatmap: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))

    # Endgame
    climb: str = "none"               # none / l1 / l2 / l3
    climb_seconds: Optional[float] = None

    # Qualitative / reliability
    played_defense: bool = False
    defense_rating: int = 0           # 0..5
    defense_on: str = ""              # teams they defended (free text)
    successful_stops: int = 0
    driver_skill: int = 3             # 1..5
    speed_rating: int = 3             # 1..5
    fouls: int = 0
    failure: bool = False
    failure_details: str = ""
    notes: str = ""

    created_at: datetime = Field(default_factory=_now)

    # Derived scoring proxy, filled on insert (so analytics are cheap).
    points: float = 0.0


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
# TBA / match cache                                                            #
# --------------------------------------------------------------------------- #
class MatchRecord(SQLModel, table=True):
    __table_args__ = (
        UniqueConstraint("match_key", name="uq_match_key"),
    )
    id: Optional[int] = Field(default=None, primary_key=True)
    match_key: str = Field(index=True)
    event_key: str = Field(index=True)
    comp_level: str = "qm"
    match_number: int = 0
    red: list[int] = Field(default_factory=list, sa_column=Column(JSON))
    blue: list[int] = Field(default_factory=list, sa_column=Column(JSON))
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
