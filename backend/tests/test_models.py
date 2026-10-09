"""Firestore document model tests.

These lock down the contract between the team's DB schema and what actually
lands in Firestore: field names, document IDs, the identity/payload split, and
the size and ID rules the app enforces before a write is attempted.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from app import schema
from app.models import (
    MAX_JUSTIFICATION_CHARS,
    PICK_FIRST,
    PICK_SECOND,
    PICKLIST_PRIORITY,
    ROLE_ADMIN,
    ROLE_PICKLIST,
    ROLE_SCOUTER,
    ROLE_STRATEGY,
    Bet,
    Device,
    Event,
    MatchRecord,
    NetworkStatus,
    OutboxRecord,
    Picklist,
    PitEntry,
    Scouter,
    ScoutEntry,
    next_seq_id,
)

UTC = timezone.utc


def sample_match() -> MatchRecord:
    m = MatchRecord(
        match_key=schema.match_id("2026txman", "qm", 12),
        event_key="2026txman",
        comp_level="qm",
        match_number=12,
    )
    m.set_alliances([418, 436, 4414], [118, 148, 3005])
    return m


def sample_scouting(**overrides) -> ScoutEntry:
    payload = {
        "event_key": "2026txman",
        "match_number": 12,
        "comp_level": "qm",
        "team_number": 418,
        "alliance": "red",
        "station": 1,
        "scout_id": "scout-1",
        "fouls": 2,
        "auto_leave": True,
        "heatmap": [{"x": 0.2, "y": 0.4, "phase": "auto", "result": "made"}],
    }
    payload.update(overrides)
    return ScoutEntry.from_submission(payload)


# --------------------------------------------------------------------------- #
# Document IDs                                                                 #
# --------------------------------------------------------------------------- #
def test_match_document_id_is_the_tba_match_key() -> None:
    assert schema.match_id("2026txman", "qm", 12) == "2026txman_qm12"
    assert sample_match().doc_id == "2026txman_qm12"


def test_scouting_document_id_is_the_submission_uuid() -> None:
    """The UNIQUE(submission_uuid) constraint becomes the document path, which
    is what makes an offline replay physically unable to duplicate a row."""
    entry = sample_scouting(submission_id="abc-123")
    assert entry.doc_id == "abc-123"
    assert entry.to_doc()["submission_uuid"] == "abc-123"


def test_pit_document_id_is_one_per_team_per_event() -> None:
    assert schema.pit_id("2026txman", 418) == "2026txman_418"
    assert PitEntry(event_key="2026txman", team_number=418).doc_id == "2026txman_418"


@pytest.mark.parametrize("bad", ["", "   ", ".", "..", "a/b", "__proto__", "x" * 1600])
def test_safe_doc_id_rejects_ids_firestore_would_refuse(bad: str) -> None:
    with pytest.raises(ValueError):
        schema.safe_doc_id(bad)


def test_safe_doc_id_accepts_normal_scouter_ids() -> None:
    assert schema.safe_doc_id("  admin  ") == "admin"
    assert schema.safe_doc_id("42") == "42"


def test_surrogate_ids_are_monotonic_and_js_safe() -> None:
    ids = [next_seq_id() for _ in range(500)]
    assert ids == sorted(ids)
    assert len(set(ids)) == len(ids)
    assert max(ids) < 2**53  # survives JSON round-trip through the frontend


# --------------------------------------------------------------------------- #
# Field mapping (schema names out, app names in)                               #
# --------------------------------------------------------------------------- #
def test_scouting_maps_app_names_onto_schema_column_names() -> None:
    doc = sample_scouting(notes="hi", no_show=True).to_doc()
    assert doc["match_num"] == 12
    assert doc["team_num"] == 418
    assert doc["scouter_id"] == "scout-1"
    assert doc["comments"] == "hi"
    assert doc["no_show"] is True
    assert doc["match_key"] == "2026txman_qm12"
    assert doc["cloud_status"] == "synced"


def test_scouting_splits_identity_from_the_data_payload() -> None:
    """Observations live in the nested ``data`` map (the schema's JSONB
    column); identity columns stay top level so they can be queried."""
    doc = sample_scouting().to_doc()
    assert doc["data"] == {
        "auto_leave": True,
        "heatmap": [{"x": 0.2, "y": 0.4, "phase": "auto", "result": "made"}],
        "foul_count": 2,
    }
    assert "fouls" not in doc and "heatmap" not in doc


def test_scouting_round_trips_through_firestore() -> None:
    original = sample_scouting(notes="round trip", climb="l3", driver_skill=5)
    restored = ScoutEntry.from_doc(original.doc_id, original.to_doc())
    assert restored.submission_id == original.submission_id
    assert restored.match_number == 12
    assert restored.team_number == 418
    assert restored.notes == "round trip"
    assert restored.fouls == 2
    assert restored.climb == "l3"
    assert restored.driver_skill == 5
    assert restored.auto_leave is True
    assert restored.id == original.id


def test_scouter_maps_last_seen_to_last_login() -> None:
    s = Scouter(scout_id="admin", s_number=1, display_name="Administrator",
                role=ROLE_ADMIN)
    doc = s.to_doc()
    assert doc["scouter_id"] == "admin"
    assert doc["role"] == ROLE_ADMIN
    # is_admin is derived, and still written so the console stays readable.
    assert doc["is_admin"] is True
    assert "last_login" in doc and "last_seen" not in doc
    assert Scouter.from_doc("admin", doc).is_admin is True


@pytest.mark.parametrize(
    "role,is_admin,picklist_only",
    [
        (ROLE_SCOUTER, False, False),
        (ROLE_STRATEGY, False, False),
        (ROLE_ADMIN, True, False),
        (ROLE_PICKLIST, False, True),
    ],
)
def test_role_drives_permissions(role: str, is_admin: bool, picklist_only: bool) -> None:
    s = Scouter(scout_id="x", role=role)
    assert s.is_admin is is_admin
    assert s.picklist_only is picklist_only


def test_accounts_from_before_roles_keep_their_access() -> None:
    """Documents written by the previous build only carry is_admin."""
    assert Scouter.from_doc("a", {"is_admin": True}).role == ROLE_ADMIN
    assert Scouter.from_doc("b", {"is_admin": False}).role == ROLE_SCOUTER
    assert Scouter.from_doc("c", {}).role == ROLE_SCOUTER
    # An unrecognised role falls back rather than granting anything.
    assert Scouter.from_doc("d", {"role": "wizard"}).role == ROLE_SCOUTER


def test_picklist_priority_orders_master_then_strategy_then_scouter() -> None:
    assert PICKLIST_PRIORITY["master"] < PICKLIST_PRIORITY[ROLE_STRATEGY]
    assert PICKLIST_PRIORITY[ROLE_STRATEGY] == PICKLIST_PRIORITY[ROLE_ADMIN]
    assert PICKLIST_PRIORITY[ROLE_STRATEGY] < PICKLIST_PRIORITY[ROLE_SCOUTER]


def test_picklist_items_carry_a_justification_and_drop_duplicates() -> None:
    items = Picklist.normalize_items([
        {"team": 254, "justification": "best cycler"},
        {"team": 118, "note": "good defense"},
        {"team": 254, "note": "same team again"},
        {"team": 0},
    ])
    assert [i["rank"] for i in items] == [1, 2]
    assert items[0]["justification"] == items[0]["note"] == items[0]["comments"] == "best cycler"
    assert items[1]["team_num"] == 118


def test_justification_is_capped_so_a_document_cannot_balloon() -> None:
    items = Picklist.normalize_items([{"team": 1, "note": "x" * 50_000}])
    assert len(items[0]["note"]) == MAX_JUSTIFICATION_CHARS


def test_picklists_are_split_by_pick_round() -> None:
    first = Picklist(event_key="e", owner_id="1", pick_round=PICK_FIRST)
    second = Picklist(event_key="e", owner_id="1", pick_round=PICK_SECOND)
    assert first.to_doc()["pick_round"] == 1
    assert second.to_doc()["pick_round"] == 2
    assert "First Pick" in Picklist.default_name(PICK_FIRST, "Alex")
    assert "Second Pick" in Picklist.default_name(PICK_SECOND, "Alex")


def test_event_stores_a_date_as_a_timestamp_and_derives_the_year() -> None:
    doc = Event(event_key="2026txman", start_date=date(2026, 3, 1)).to_doc()
    assert doc["start_date"] == datetime(2026, 3, 1, tzinfo=UTC)
    assert doc["year"] == 2026
    assert Event.from_doc("2026txman", doc).start_date == date(2026, 3, 1)


def test_match_alliances_round_trip_as_flat_columns() -> None:
    doc = sample_match().to_doc()
    assert (doc["red1"], doc["red2"], doc["red3"]) == (418, 436, 4414)
    assert (doc["blue1"], doc["blue2"], doc["blue3"]) == (118, 148, 3005)
    assert doc["betting_locked"] is False
    restored = MatchRecord.from_doc(doc["match_key"], doc)
    assert restored.red == [418, 436, 4414]
    assert restored.blue == [118, 148, 3005]


def test_match_handles_a_short_alliance() -> None:
    m = sample_match()
    m.set_alliances([418, 436], [118])
    assert m.red == [418, 436]
    assert m.blue == [118]
    assert m.to_doc()["red3"] is None


def test_picklist_items_get_contiguous_ranks_and_both_field_names() -> None:
    p = Picklist(
        event_key="2026txman",
        owner_id="scout-1",
        name="First Picks",
        items=[{"team": 148, "note": "fast"}, {"team": 118, "tier": "first"}],
    )
    items = p.to_doc()["items"]
    assert [i["rank"] for i in items] == [1, 2]
    # The schema's names and the API's names are both present, so the stored
    # document matches the design doc without breaking the frontend contract.
    assert items[0]["team"] == items[0]["team_num"] == 148
    assert items[0]["note"] == items[0]["comments"] == "fast"
    assert p.to_doc()["picklist_name"] == "First Picks"


def test_bet_round_trips() -> None:
    b = Bet(
        scout_id="scout-1", event_key="2026txman", match_key="2026txman_qm12",
        match_number=12, pick="red", wager=25, win_prob=0.62,
        multiplier=1.55, potential_payout=39,
    )
    doc = b.to_doc()
    assert doc["status"] == "open"
    assert doc["resolved_at"] is None
    assert doc["scouter_id"] == "scout-1"
    assert Bet.from_doc(doc["bet_id"] and str(doc["bet_id"]), doc).wager == 25


def test_device_network_and_outbox_use_schema_field_names() -> None:
    assert set(Device(device_id="cb-01").to_doc()) >= {
        "device_id", "role", "vlan_port", "last_seen_at", "battery_pct"
    }
    assert set(NetworkStatus().to_doc()) >= {
        "status_id", "recorded_at", "active_carrier", "signal_quality",
        "packet_loss", "unsynced_count", "oldest_queued_submission_uuid",
    }
    assert set(OutboxRecord(submission_id="u-1").to_doc()) >= {
        "submission_uuid", "status", "attempt_count", "last_attempt_at",
        "acknowledged_at", "created_at",
    }


# --------------------------------------------------------------------------- #
# Timestamps                                                                   #
# --------------------------------------------------------------------------- #
def test_timestamps_are_normalised_to_aware_utc() -> None:
    entry = sample_scouting(client_ts="2026-03-01T10:30:00Z")
    assert entry.client_ts == datetime(2026, 3, 1, 10, 30, tzinfo=UTC)
    # A naive timestamp coming back out of Firestore is treated as UTC.
    restored = ScoutEntry.from_doc(
        "x", {**entry.to_doc(), "submitted_at": datetime(2026, 3, 1, 10, 30)}
    )
    assert restored.created_at.tzinfo is not None


def test_junk_client_timestamps_are_dropped_not_raised() -> None:
    assert sample_scouting(client_ts="not a date").client_ts is None
    assert sample_scouting(client_ts=None).client_ts is None


# --------------------------------------------------------------------------- #
# Firestore limits                                                             #
# --------------------------------------------------------------------------- #
def test_documents_stay_well_under_the_one_mib_limit() -> None:
    from app.cache import doc_bytes

    entry = sample_scouting(
        heatmap=[{"x": 0.5, "y": 0.5, "phase": "teleop", "result": "made"}]
                * schema.MAX_HEATMAP_ATTEMPTS,
        notes="x" * schema.MAX_NOTES_CHARS,
        tags=["Fast cycles"] * schema.MAX_TAGS,
    )
    # A maximally-sized submission must still fit comfortably.
    assert doc_bytes(entry.to_doc()) < schema.MAX_DOC_BYTES
    assert schema.MAX_DOC_BYTES < 1024 * 1024


def test_batch_and_index_limits_match_firestore_documented_ceilings() -> None:
    assert schema.MAX_BATCH_OPS < 500          # ops per commit
    assert schema.MAX_BATCH_BYTES < 10 << 20   # bytes per commit
    assert schema.MAX_PHOTO_BYTES < schema.MAX_DOC_BYTES


def test_heavy_json_fields_are_exempt_from_indexing() -> None:
    """Index entries are charged per write and capped at 40k per document, so
    the array/blob fields nothing queries on must not be indexed."""
    assert "data" in schema.INDEX_EXEMPT_FIELDS[schema.MATCH_SCOUTING]
    assert "items" in schema.INDEX_EXEMPT_FIELDS[schema.PICKLISTS]
    assert "avatar" in schema.INDEX_EXEMPT_FIELDS[schema.TEAM_CACHE]
    assert "robot_photo" in schema.INDEX_EXEMPT_FIELDS[schema.PIT_SCOUTING]
    for override in schema.index_exemptions():
        assert override["indexes"] == []
        assert override["collectionGroup"] in schema.ALL_COLLECTIONS


# --------------------------------------------------------------------------- #
# Collection coverage                                                          #
# --------------------------------------------------------------------------- #
def test_every_collection_in_the_db_schema_has_a_model() -> None:
    from app.models import MODEL_FOR_COLLECTION

    # app_settings is a plain key/value map with no model of its own.
    modelled = set(MODEL_FOR_COLLECTION) | {schema.APP_SETTINGS}
    assert modelled == set(schema.ALL_COLLECTIONS)

    for collection, model in MODEL_FOR_COLLECTION.items():
        assert model.COLLECTION == collection


def test_cached_collections_partition_cleanly() -> None:
    cached = set(schema.GLOBAL_CACHED) | set(schema.EVENT_SCOPED_CACHED)
    assert not (set(schema.GLOBAL_CACHED) & set(schema.EVENT_SCOPED_CACHED))
    assert cached | set(schema.WRITE_ONLY) == set(schema.ALL_COLLECTIONS)
    # Event-scoped collections must actually carry the field they're filtered on.
    from app.models import MODEL_FOR_COLLECTION

    for collection in schema.EVENT_SCOPED_CACHED:
        model = MODEL_FOR_COLLECTION[collection]
        fields = model.__dataclass_fields__
        assert schema.EVENT_FILTER_FIELD in fields, collection
