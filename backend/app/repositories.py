"""Persistence boundary for HazeHub's core MongoDB documents.

MongoDB does not provide cross-collection foreign keys, so this repository
checks event, match, scouter, and alliance references before writes.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pymongo import ReturnDocument
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError

from .models import (
    BetDocument,
    EventDocument,
    MatchDocument,
    MatchScoutingDocument,
    PicklistDocument,
    PitScoutingDocument,
    ScouterDocument,
    TeamCacheDocument,
)


class RepositoryError(RuntimeError):
    pass


class ReferenceNotFoundError(RepositoryError):
    pass


class ConflictError(RepositoryError):
    pass


class AllianceMismatchError(ConflictError):
    """The scouted team is not on the claimed alliance for that match."""


class HazeHubRepository:
    def __init__(self, database: Database):
        self.database = database

    def create_scouter(self, scouter: ScouterDocument) -> dict[str, Any]:
        return self._insert("scouters", scouter.to_bson())

    def upsert_event(self, event: EventDocument) -> dict[str, Any]:
        document = event.to_bson()
        return self._upsert("events", event.event_key, document)

    def upsert_match(self, match: MatchDocument) -> dict[str, Any]:
        if self.database.events.find_one({"_id": match.event_key}, {"_id": 1}) is None:
            raise ReferenceNotFoundError(f"event {match.event_key!r} does not exist")
        document = match.to_bson()
        return self._upsert("matches", match.match_key, document)

    def submit_match_scouting(
        self, scouting: MatchScoutingDocument, *, require_match: bool = False
    ) -> dict[str, Any]:
        """Insert one scouting report.

        The scouter must exist. When the match is in the schedule, the scouted
        team must be on the claimed alliance; a missing match is only an error
        when ``require_match`` is set (live events sometimes get scouted before
        TBA publishes the schedule, so lenient is the API default).
        """
        if self.database.scouters.find_one(
            {"_id": scouting.scouter_id}, {"_id": 1}
        ) is None:
            raise ReferenceNotFoundError(
                f"scouter {scouting.scouter_id!r} does not exist"
            )

        match = self.database.matches.find_one({"_id": scouting.match_key})
        if match is None and require_match:
            raise ReferenceNotFoundError(f"match {scouting.match_key!r} does not exist")

        if match is not None:
            alliance_teams = match["alliances"][str(scouting.alliance)]["teams"]
            if scouting.team_num not in alliance_teams:
                raise AllianceMismatchError(
                    f"team {scouting.team_num} is not on the {scouting.alliance} "
                    f"alliance in {scouting.match_key}"
                )

        return self._insert("match_scouting", scouting.to_bson())

    def save_picklist(self, picklist: PicklistDocument) -> dict[str, Any]:
        if self.database.events.find_one({"_id": picklist.event_key}, {"_id": 1}) is None:
            # Auto-provision the event stub: picklists may be drafted before an
            # admin has pulled the TBA schedule for the event.
            self.upsert_event(EventDocument(_id=picklist.event_key))

        document = picklist.to_bson()
        return self._upsert("picklists", picklist.picklist_id, document)

    def place_bet(self, bet: BetDocument) -> dict[str, Any]:
        if self.database.matches.find_one({"_id": bet.match_key}, {"_id": 1}) is None:
            raise ReferenceNotFoundError(f"match {bet.match_key!r} does not exist")
        return self._insert("bets", bet.to_bson())

    def upsert_pit_scouting(self, pit: PitScoutingDocument) -> dict[str, Any]:
        existing = self.database.pit_scouting.find_one(
            {"event_key": pit.event_key, "team_num": pit.team_num}, {"_id": 1}
        )
        document_id = existing["_id"] if existing else pit.pit_id
        return self._upsert("pit_scouting", document_id, pit.to_bson())

    def upsert_team_cache(self, team: TeamCacheDocument) -> dict[str, Any]:
        return self._upsert("team_cache", team.team_number, team.to_bson())

    def _insert(self, collection_name: str, document: dict[str, Any]) -> dict[str, Any]:
        try:
            self.database[collection_name].insert_one(document)
        except DuplicateKeyError as exc:
            raise ConflictError(
                f"{collection_name} document conflicts with an existing unique key"
            ) from exc
        return document

    def _upsert(
        self, collection_name: str, document_id: Any, document: dict[str, Any]
    ) -> dict[str, Any]:
        if document_id in (None, ""):
            raise ValueError("document _id is required")
        fields = dict(document)
        fields.pop("_id", None)
        # Only manage created_at for document types that carry one; injecting
        # it elsewhere would violate the strict collection validators.
        set_on_insert: dict[str, Any] = {"_id": document_id}
        if "created_at" in fields:
            set_on_insert["created_at"] = fields.pop("created_at") or datetime.now(UTC)
        fields["updated_at"] = datetime.now(UTC)
        try:
            result = self.database[collection_name].find_one_and_update(
                {"_id": document_id},
                {
                    "$set": fields,
                    "$setOnInsert": set_on_insert,
                },
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
        except DuplicateKeyError as exc:
            raise ConflictError(
                f"{collection_name} document conflicts with an existing unique key"
            ) from exc
        if result is None:
            raise RepositoryError(f"failed to persist {collection_name} document")
        return result
