"""Validated MongoDB document models for HazeHub.

MongoDB itself is configured with matching JSON Schema validators in
``app.schema``.  These Pydantic models validate data before it reaches the
database and provide a single canonical BSON shape for the application.

The core five collections (scouters, events, matches, match_scouting,
picklists) follow the backend-dev schema design; the app-layer collections
(bets, pit_scouting, team_cache, app_settings, external_cache, activity)
extend it to cover the full HazeHub feature set.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from enum import StrEnum
from typing import Any, Self
from uuid import UUID, uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    field_validator,
    model_validator,
)


def utc_now() -> datetime:
    return datetime.now(UTC)


def _ensure_aware(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamps must include a timezone")
    return value.astimezone(UTC)


def _validate_uuid(value: str) -> str:
    try:
        UUID(value)
    except ValueError as exc:
        raise ValueError("_id must be a UUID string") from exc
    return value


class DocumentModel(BaseModel):
    """Base model whose output can be inserted directly with PyMongo."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
        use_enum_values=True,
    )

    def to_bson(self) -> dict[str, Any]:
        document = self.model_dump(mode="python", by_alias=True, exclude_none=False)
        return _dates_to_bson(document)


def _dates_to_bson(value: Any) -> Any:
    """Convert Python-only ``date`` values to MongoDB BSON datetimes."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, time.min, tzinfo=UTC)
    if isinstance(value, dict):
        return {key: _dates_to_bson(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dates_to_bson(item) for item in value]
    return value


class CompetitionLevel(StrEnum):
    QUALIFICATION = "qm"
    QUARTERFINAL = "qf"
    SEMIFINAL = "sf"
    FINAL = "f"


class AllianceColor(StrEnum):
    RED = "red"
    BLUE = "blue"


class MatchOutcome(StrEnum):
    RED = "red"
    BLUE = "blue"
    TIE = "tie"


class BetStatus(StrEnum):
    OPEN = "open"
    WON = "won"
    LOST = "lost"
    REFUNDED = "refunded"


class PicklistTier(StrEnum):
    FIRST = "first"
    SECOND = "second"
    THIRD = "third"
    DNP = "dnp"


def build_match_key(
    event_key: str,
    comp_level: CompetitionLevel | str,
    set_number: int,
    match_num: int,
) -> str:
    """Build a TBA-compatible match key (for example, 2026txman_qm12)."""
    level = CompetitionLevel(comp_level)
    if level is CompetitionLevel.QUALIFICATION:
        return f"{event_key}_qm{match_num}"
    return f"{event_key}_{level.value}{set_number}m{match_num}"


class ScouterDocument(DocumentModel):
    scouter_id: str = Field(alias="_id", min_length=1, max_length=100)
    s_number: int = Field(ge=1)
    display_name: str = Field(min_length=1, max_length=100)
    is_admin: bool = False
    bucks: int = Field(default=100, ge=0)
    matches_scouted: int = Field(default=0, ge=0)
    last_seen: datetime = Field(default_factory=utc_now)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("created_at", "updated_at", "last_seen")(
        _ensure_aware
    )


class EventDocument(DocumentModel):
    event_key: str = Field(alias="_id", pattern=r"^\d{4}[a-z0-9]+$")
    year: int | None = Field(default=None, ge=1992, le=2200)
    name: str | None = Field(default=None, max_length=200)
    start_date: date | None = None
    end_date: date | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("created_at", "updated_at")(_ensure_aware)

    @model_validator(mode="after")
    def derive_and_check_year(self) -> Self:
        key_year = int(self.event_key[:4])
        if self.year is None:
            self.year = key_year
        elif self.year != key_year:
            raise ValueError("event year must match the first four event_key digits")
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date cannot be before start_date")
        return self


class AllianceTeams(DocumentModel):
    # FRC alliances are 3 robots; tolerate 1-4 so partial/offseason schedules
    # from TBA never brick an event sync.
    teams: list[int] = Field(min_length=1, max_length=4)
    score: int | None = Field(default=None, ge=-1)

    @field_validator("teams")
    @classmethod
    def validate_teams(cls, teams: list[int]) -> list[int]:
        if any(team <= 0 for team in teams):
            raise ValueError("team numbers must be positive")
        if len(set(teams)) != len(teams):
            raise ValueError("an alliance cannot contain the same team twice")
        return teams


class MatchAlliances(DocumentModel):
    red: AllianceTeams
    blue: AllianceTeams


class MatchDocument(DocumentModel):
    match_key: str | None = Field(default=None, alias="_id")
    event_key: str = Field(pattern=r"^\d{4}[a-z0-9]+$")
    comp_level: CompetitionLevel
    set_number: int = Field(default=1, ge=1)
    match_num: int = Field(ge=1)
    alliances: MatchAlliances
    winner: MatchOutcome | None = None
    predicted_time: int | None = Field(default=None, ge=0)
    # App state: Purple Bucks betting + film review.
    betting_locked: bool = False
    youtube_key: str = Field(default="", max_length=200)
    film_summary: str = Field(default="", max_length=20000)
    film_events: list[dict[str, JsonValue]] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("created_at", "updated_at")(_ensure_aware)

    @model_validator(mode="after")
    def validate_match(self) -> Self:
        expected_key = build_match_key(
            self.event_key, self.comp_level, self.set_number, self.match_num
        )
        if self.match_key is None:
            self.match_key = expected_key
        elif self.match_key != expected_key:
            raise ValueError(f"match_key must be {expected_key!r}")

        red = set(self.alliances.red.teams)
        blue = set(self.alliances.blue.teams)
        if red & blue:
            raise ValueError("a team cannot appear on both alliances")
        return self


class ScoutingData(BaseModel):
    """Season-specific scouting payload.

    Extra keys are intentionally allowed because game-specific fields change
    each season (heatmap, climb, ratings, tags, failure details, …).
    ``foul_count`` is stable and always stored under the corrected spelling.
    """

    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    __pydantic_extra__: dict[str, JsonValue] = Field(init=False)
    foul_count: int = Field(default=0, ge=0)


class MatchScoutingDocument(DocumentModel):
    scouting_id: str = Field(
        default_factory=lambda: str(uuid4()), alias="_id", min_length=36, max_length=36
    )
    client_submission_id: str | None = Field(default=None, min_length=1, max_length=100)
    event_key: str = Field(pattern=r"^\d{4}[a-z0-9]+$")
    match_key: str | None = None
    comp_level: CompetitionLevel
    set_number: int = Field(default=1, ge=1)
    match_num: int = Field(ge=1)
    team_num: int = Field(ge=1)
    alliance: AllianceColor
    station: int = Field(default=1, ge=1, le=3)
    scouter_id: str = Field(min_length=1, max_length=100)
    data: ScoutingData
    points: float = Field(default=0.0, ge=0)
    no_show: bool = False
    comments: str | None = Field(default=None, max_length=5000)
    submitted_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("submitted_at", "updated_at")(_ensure_aware)
    _uuid_id = field_validator("scouting_id")(_validate_uuid)

    @model_validator(mode="after")
    def derive_and_check_match_key(self) -> Self:
        expected_key = build_match_key(
            self.event_key, self.comp_level, self.set_number, self.match_num
        )
        if self.match_key is None:
            self.match_key = expected_key
        elif self.match_key != expected_key:
            raise ValueError(f"match_key must be {expected_key!r}")
        return self


class PicklistItem(DocumentModel):
    rank: int = Field(ge=1)
    team_num: int = Field(ge=1)
    tier: PicklistTier = PicklistTier.SECOND
    comments: str | None = Field(default=None, max_length=5000)


class PicklistDocument(DocumentModel):
    picklist_id: str = Field(
        default_factory=lambda: str(uuid4()), alias="_id", min_length=36, max_length=36
    )
    event_key: str = Field(pattern=r"^\d{4}[a-z0-9]+$")
    owner_id: str = Field(min_length=1, max_length=100)
    picklist_name: str = Field(min_length=1, max_length=200)
    items: list[PicklistItem] = Field(default_factory=list)
    is_master: bool = False
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("created_at", "updated_at")(_ensure_aware)
    _uuid_id = field_validator("picklist_id")(_validate_uuid)

    @field_validator("items")
    @classmethod
    def validate_items(cls, items: list[PicklistItem]) -> list[PicklistItem]:
        ranks = [item.rank for item in items]
        teams = [item.team_num for item in items]
        if len(ranks) != len(set(ranks)):
            raise ValueError("picklist ranks must be unique")
        if len(teams) != len(set(teams)):
            raise ValueError("a team can appear only once in a picklist")
        if sorted(ranks) != list(range(1, len(items) + 1)):
            raise ValueError("picklist ranks must be contiguous and start at 1")
        return sorted(items, key=lambda item: item.rank)


# --------------------------------------------------------------------------- #
# App-layer collections                                                        #
# --------------------------------------------------------------------------- #
class BetDocument(DocumentModel):
    bet_id: str = Field(
        default_factory=lambda: str(uuid4()), alias="_id", min_length=36, max_length=36
    )
    scouter_id: str = Field(min_length=1, max_length=100)
    event_key: str = Field(pattern=r"^\d{4}[a-z0-9]+$")
    match_key: str = Field(min_length=1)
    match_num: int = Field(ge=1)
    comp_level: CompetitionLevel = CompetitionLevel.QUALIFICATION
    pick: AllianceColor
    wager: int = Field(ge=1)
    win_prob: float = Field(ge=0.0, le=1.0)
    multiplier: float = Field(ge=1.0)
    potential_payout: int = Field(ge=0)
    status: BetStatus = BetStatus.OPEN
    payout: int = Field(default=0, ge=0)
    created_at: datetime = Field(default_factory=utc_now)
    resolved_at: datetime | None = None

    _timestamps_tz = field_validator("created_at")(_ensure_aware)
    _uuid_id = field_validator("bet_id")(_validate_uuid)


class PitScoutingDocument(DocumentModel):
    pit_id: str = Field(
        default_factory=lambda: str(uuid4()), alias="_id", min_length=36, max_length=36
    )
    event_key: str = Field(pattern=r"^\d{4}[a-z0-9]+$")
    team_num: int = Field(ge=1)
    scouter_id: str = Field(default="", max_length=100)
    drivetrain: str = Field(default="", max_length=200)
    weight_lbs: float | None = Field(default=None, ge=0)
    width_in: float | None = Field(default=None, ge=0)
    length_in: float | None = Field(default=None, ge=0)
    can_climb: str = Field(default="none", max_length=20)
    auto_routine: str = Field(default="", max_length=2000)
    capabilities: list[str] = Field(default_factory=list)
    robot_photo: str = ""  # data URI or URL captured in the pit
    notes: str = Field(default="", max_length=5000)
    updated_at: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("updated_at")(_ensure_aware)
    _uuid_id = field_validator("pit_id")(_validate_uuid)


class TeamCacheDocument(DocumentModel):
    team_number: int = Field(alias="_id", ge=1)
    nickname: str = Field(default="", max_length=200)
    name: str = Field(default="", max_length=500)
    city: str = Field(default="", max_length=100)
    state: str = Field(default="", max_length=100)
    country: str = Field(default="", max_length=100)
    rookie_year: int | None = Field(default=None, ge=1992, le=2200)
    avatar: str = ""  # data URI (TBA avatar)
    photos: list[str] = Field(default_factory=list)
    epa: float | None = None
    updated_at: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("updated_at")(_ensure_aware)


class AppSettingDocument(DocumentModel):
    key: str = Field(alias="_id", min_length=1, max_length=100)
    value: str = Field(default="", max_length=500)
    updated_at: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("updated_at")(_ensure_aware)


class ExternalCacheDocument(DocumentModel):
    url: str = Field(alias="_id", min_length=1, max_length=2000)
    payload: JsonValue = None
    fetched_at: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("fetched_at")(_ensure_aware)


class ActivityDocument(DocumentModel):
    """A realtime change event, polled by clients (Vercel has no WebSockets)."""

    activity_id: str = Field(
        default_factory=lambda: str(uuid4()), alias="_id", min_length=36, max_length=36
    )
    event: str = Field(min_length=1, max_length=100)
    payload: JsonValue = None
    ts: datetime = Field(default_factory=utc_now)

    _timestamps_tz = field_validator("ts")(_ensure_aware)
    _uuid_id = field_validator("activity_id")(_validate_uuid)
