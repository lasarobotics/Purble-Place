"""Read-side data access: thin views over MongoDB documents.

The Mongo documents use the schema's field names (``match_num``,
``scouter_id``, ``comments``); the API and analytics layers speak the
frontend contract (``match_number``, ``scout_id``, ``notes``).  These view
classes adapt one to the other so the analytics engine reads naturally.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Iterable, Optional

from pymongo.database import Database


def _aware(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    return datetime.now(UTC)


class ScouterView:
    def __init__(self, doc: dict[str, Any]):
        self._doc = doc

    @property
    def scout_id(self) -> str:
        return str(self._doc["_id"])

    @property
    def s_number(self) -> int:
        return int(self._doc.get("s_number") or 0)

    @property
    def display_name(self) -> str:
        return str(self._doc.get("display_name") or self.scout_id)

    @property
    def is_admin(self) -> bool:
        return bool(self._doc.get("is_admin", False))

    @property
    def bucks(self) -> int:
        return int(self._doc.get("bucks", 0))

    @property
    def matches_scouted(self) -> int:
        return int(self._doc.get("matches_scouted", 0))

    @property
    def last_seen(self) -> datetime:
        return _aware(self._doc.get("last_seen"))


class EntryView:
    """One match-scouting report, exposed with API-contract field names."""

    def __init__(self, doc: dict[str, Any]):
        self._doc = doc
        self._data: dict[str, Any] = doc.get("data") or {}

    def _d(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    @property
    def id(self) -> str:
        return str(self._doc["_id"])

    @property
    def client_uuid(self) -> Optional[str]:
        return self._doc.get("client_submission_id")

    @property
    def event_key(self) -> str:
        return str(self._doc.get("event_key") or "")

    @property
    def comp_level(self) -> str:
        return str(self._doc.get("comp_level") or "qm")

    @property
    def match_number(self) -> int:
        return int(self._doc.get("match_num") or 0)

    @property
    def team_number(self) -> int:
        return int(self._doc.get("team_num") or 0)

    @property
    def alliance(self) -> str:
        return str(self._doc.get("alliance") or "red")

    @property
    def station(self) -> int:
        return int(self._doc.get("station") or 1)

    @property
    def scout_id(self) -> str:
        return str(self._doc.get("scouter_id") or "")

    @property
    def points(self) -> float:
        return float(self._doc.get("points") or 0.0)

    @property
    def no_show(self) -> bool:
        return bool(self._doc.get("no_show", False))

    @property
    def notes(self) -> str:
        return str(self._doc.get("comments") or "")

    @property
    def created_at(self) -> datetime:
        return _aware(self._doc.get("submitted_at"))

    # ---- season payload ----------------------------------------------------
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


class MatchView:
    def __init__(self, doc: dict[str, Any]):
        self._doc = doc

    def _alliance(self, color: str) -> dict[str, Any]:
        return (self._doc.get("alliances") or {}).get(color) or {}

    @property
    def match_key(self) -> str:
        return str(self._doc["_id"])

    @property
    def event_key(self) -> str:
        return str(self._doc.get("event_key") or "")

    @property
    def comp_level(self) -> str:
        return str(self._doc.get("comp_level") or "qm")

    @property
    def set_number(self) -> int:
        return int(self._doc.get("set_number") or 1)

    @property
    def match_number(self) -> int:
        return int(self._doc.get("match_num") or 0)

    @property
    def red(self) -> list[int]:
        return [int(t) for t in self._alliance("red").get("teams") or []]

    @property
    def blue(self) -> list[int]:
        return [int(t) for t in self._alliance("blue").get("teams") or []]

    def _score(self, color: str) -> Optional[int]:
        score = self._alliance(color).get("score")
        if score is None or int(score) < 0:
            return None
        return int(score)

    @property
    def red_score(self) -> Optional[int]:
        return self._score("red")

    @property
    def blue_score(self) -> Optional[int]:
        return self._score("blue")

    @property
    def winner(self) -> Optional[str]:
        return self._doc.get("winner")

    @property
    def predicted_time(self) -> Optional[int]:
        return self._doc.get("predicted_time")

    @property
    def betting_locked(self) -> bool:
        return bool(self._doc.get("betting_locked", False))

    @property
    def youtube_key(self) -> str:
        return str(self._doc.get("youtube_key") or "")

    @property
    def film_summary(self) -> str:
        return str(self._doc.get("film_summary") or "")

    @property
    def film_events(self) -> list[dict[str, Any]]:
        return self._doc.get("film_events") or []


class TeamView:
    def __init__(self, doc: dict[str, Any]):
        self._doc = doc

    @property
    def team_number(self) -> int:
        return int(self._doc["_id"])

    @property
    def nickname(self) -> str:
        return str(self._doc.get("nickname") or "")

    @property
    def name(self) -> str:
        return str(self._doc.get("name") or "")

    @property
    def city(self) -> str:
        return str(self._doc.get("city") or "")

    @property
    def state(self) -> str:
        return str(self._doc.get("state") or "")

    @property
    def country(self) -> str:
        return str(self._doc.get("country") or "")

    @property
    def rookie_year(self) -> Optional[int]:
        return self._doc.get("rookie_year")

    @property
    def avatar(self) -> str:
        return str(self._doc.get("avatar") or "")

    @property
    def photos(self) -> list[str]:
        return self._doc.get("photos") or []

    @property
    def epa(self) -> Optional[float]:
        epa = self._doc.get("epa")
        return float(epa) if epa is not None else None


# --------------------------------------------------------------------------- #
# Query helpers                                                                #
# --------------------------------------------------------------------------- #
_MATCH_ORDER = {"qm": 0, "ef": 1, "qf": 2, "sf": 3, "f": 4}


def get_scouter(db: Database, scout_id: str) -> Optional[ScouterView]:
    doc = db.scouters.find_one({"_id": scout_id})
    return ScouterView(doc) if doc else None


def list_scouters(db: Database) -> list[ScouterView]:
    return [ScouterView(d) for d in db.scouters.find({})]


def scouter_names(db: Database, scout_ids: Iterable[str]) -> dict[str, str]:
    ids = [s for s in set(scout_ids) if s]
    if not ids:
        return {}
    return {
        str(d["_id"]): str(d.get("display_name") or d["_id"])
        for d in db.scouters.find({"_id": {"$in": ids}}, {"display_name": 1})
    }


def get_team_cache(db: Database, team_number: int) -> Optional[TeamView]:
    doc = db.team_cache.find_one({"_id": int(team_number)})
    return TeamView(doc) if doc else None


def get_teams_cache(db: Database, team_numbers: Iterable[int]) -> dict[int, TeamView]:
    nums = [int(n) for n in set(team_numbers) if n]
    if not nums:
        return {}
    return {
        int(d["_id"]): TeamView(d) for d in db.team_cache.find({"_id": {"$in": nums}})
    }


def get_match(db: Database, match_key: str) -> Optional[MatchView]:
    doc = db.matches.find_one({"_id": match_key})
    return MatchView(doc) if doc else None


def list_matches(db: Database, event_key: str) -> list[MatchView]:
    rows = [MatchView(d) for d in db.matches.find({"event_key": event_key})]
    rows.sort(
        key=lambda m: (
            _MATCH_ORDER.get(m.comp_level, 9),
            m.set_number,
            m.match_number,
        )
    )
    return rows


def list_entries(
    db: Database,
    event_key: str | None = None,
    *,
    team: int | None = None,
    scout_id: str | None = None,
    match_number: int | None = None,
) -> list[EntryView]:
    query: dict[str, Any] = {}
    if event_key:
        query["event_key"] = event_key
    if team is not None:
        query["team_num"] = int(team)
    if scout_id is not None:
        query["scouter_id"] = scout_id
    if match_number is not None:
        query["match_num"] = int(match_number)
    rows = [EntryView(d) for d in db.match_scouting.find(query)]
    rows.sort(key=lambda e: (e.match_number, e.created_at))
    return rows
