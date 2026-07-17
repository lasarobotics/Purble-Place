from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from bson import BSON
from pydantic import ValidationError

from app.models import (
    ActivityDocument,
    AllianceTeams,
    AppSettingDocument,
    BetDocument,
    EventDocument,
    ExternalCacheDocument,
    MatchAlliances,
    MatchDocument,
    MatchScoutingDocument,
    PicklistDocument,
    PicklistItem,
    PitScoutingDocument,
    ScouterDocument,
    ScoutingData,
    TeamCacheDocument,
)
from app.schema import COLLECTION_INDEXES, COLLECTION_SCHEMAS


def sample_match() -> MatchDocument:
    return MatchDocument(
        event_key="2026txman",
        comp_level="qm",
        match_num=12,
        alliances=MatchAlliances(
            red=AllianceTeams(teams=[418, 436, 4414]),
            blue=AllianceTeams(teams=[118, 148, 3005]),
        ),
    )


def test_event_derives_year_and_uses_event_key_as_mongo_id() -> None:
    event = EventDocument(_id="2026txman", start_date=date(2026, 3, 1))

    assert event.year == 2026
    assert event.to_bson()["_id"] == "2026txman"
    assert event.to_bson()["start_date"] == datetime(2026, 3, 1, tzinfo=UTC)


def test_match_builds_tba_match_key_and_embeds_alliances() -> None:
    match = sample_match()
    document = match.to_bson()

    assert document["_id"] == "2026txman_qm12"
    assert document["alliances"]["red"]["teams"] == [418, 436, 4414]
    assert document["betting_locked"] is False


def test_match_rejects_team_on_both_alliances() -> None:
    with pytest.raises(ValidationError, match="both alliances"):
        MatchDocument(
            event_key="2026txman",
            comp_level="qm",
            match_num=1,
            alliances=MatchAlliances(
                red=AllianceTeams(teams=[418, 436, 4414]),
                blue=AllianceTeams(teams=[418, 148, 3005]),
            ),
        )


def test_scouting_document_has_uuid_and_corrected_foul_count() -> None:
    scouting = MatchScoutingDocument(
        event_key="2026txman",
        comp_level="qm",
        match_num=12,
        team_num=418,
        alliance="red",
        scouter_id="scout-1",
        data=ScoutingData(foul_count=2, auto_leave=True),
    )
    document = scouting.to_bson()

    assert len(document["_id"]) == 36
    assert document["match_key"] == "2026txman_qm12"
    assert document["data"] == {"foul_count": 2, "auto_leave": True}
    assert document["station"] == 1
    assert document["points"] == 0.0
    assert BSON.encode(document)


def test_picklist_requires_contiguous_unique_ranks_and_teams() -> None:
    picklist = PicklistDocument(
        event_key="2026txman",
        owner_id="scout-1",
        picklist_name="First Picks",
        items=[
            PicklistItem(rank=2, team_num=148),
            PicklistItem(rank=1, team_num=118, tier="first"),
        ],
    )
    assert [item.rank for item in picklist.items] == [1, 2]
    assert picklist.items[0].tier == "first"

    with pytest.raises(ValidationError, match="contiguous"):
        PicklistDocument(
            event_key="2026txman",
            owner_id="scout-1",
            picklist_name="Broken",
            items=[PicklistItem(rank=2, team_num=118)],
        )


def test_timestamps_must_be_timezone_aware() -> None:
    with pytest.raises(ValidationError, match="timezone"):
        EventDocument(_id="2026txman", created_at=datetime(2026, 1, 1))

    event = EventDocument(
        _id="2026txman", created_at=datetime(2026, 1, 1, tzinfo=UTC)
    )
    assert event.created_at.tzinfo is UTC


def test_bet_document_validates_pick_and_wager() -> None:
    bet = BetDocument(
        scouter_id="scout-1",
        event_key="2026txman",
        match_key="2026txman_qm12",
        match_num=12,
        pick="red",
        wager=25,
        win_prob=0.62,
        multiplier=1.55,
        potential_payout=39,
    )
    document = bet.to_bson()
    assert document["status"] == "open"
    assert document["resolved_at"] is None
    assert BSON.encode(document)

    with pytest.raises(ValidationError):
        BetDocument(
            scouter_id="scout-1",
            event_key="2026txman",
            match_key="2026txman_qm12",
            match_num=12,
            pick="green",  # not an alliance
            wager=25,
            win_prob=0.62,
            multiplier=1.55,
            potential_payout=39,
        )


def test_every_collection_has_database_schema_and_indexes_entry() -> None:
    expected = {
        "scouters",
        "events",
        "matches",
        "match_scouting",
        "picklists",
        "bets",
        "pit_scouting",
        "team_cache",
        "app_settings",
        "external_cache",
        "activity",
    }
    assert set(COLLECTION_SCHEMAS) == expected
    assert set(COLLECTION_INDEXES) == expected


def test_model_documents_match_database_schema_top_level() -> None:
    documents = {
        "scouters": ScouterDocument(
            _id="scout-1", s_number=1, display_name="TestScouter"
        ).to_bson(),
        "events": EventDocument(_id="2026txman").to_bson(),
        "matches": sample_match().to_bson(),
        "match_scouting": MatchScoutingDocument(
            event_key="2026txman",
            comp_level="qm",
            match_num=12,
            team_num=418,
            alliance="red",
            scouter_id="scout-1",
            data=ScoutingData(),
        ).to_bson(),
        "picklists": PicklistDocument(
            event_key="2026txman",
            owner_id="scout-1",
            picklist_name="Test",
        ).to_bson(),
        "bets": BetDocument(
            scouter_id="scout-1",
            event_key="2026txman",
            match_key="2026txman_qm12",
            match_num=12,
            pick="blue",
            wager=10,
            win_prob=0.4,
            multiplier=2.35,
            potential_payout=24,
        ).to_bson(),
        "pit_scouting": PitScoutingDocument(
            event_key="2026txman", team_num=418
        ).to_bson(),
        "team_cache": TeamCacheDocument(_id=418, nickname="Purple Haze").to_bson(),
        "app_settings": AppSettingDocument(_id="current_event", value="2026txman").to_bson(),
        "external_cache": ExternalCacheDocument(
            _id="https://example.com", payload={"ok": True}
        ).to_bson(),
        "activity": ActivityDocument(event="scout_submitted", payload={"team": 418}).to_bson(),
    }

    for collection_name, document in documents.items():
        schema = COLLECTION_SCHEMAS[collection_name]
        assert set(schema["required"]) <= set(document)
        assert set(document) <= set(schema["properties"])
        assert BSON.encode(document)
