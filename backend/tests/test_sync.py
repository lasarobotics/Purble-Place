from unittest.mock import MagicMock, patch

from pymongo.errors import BulkWriteError

from app.routers.scouting import ScoutIn
from app.routers.sync import SyncIn, sync_scout
from app.views import ScouterView


def scout(uuid="one", event="2026test", team=1):
    return ScoutIn(client_uuid=uuid, event_key=event, match_number=1, team_number=team)


def setup():
    db = MagicMock()
    db.match_scouting.find.return_value = []
    db.matches.find.return_value = []
    return db, ScouterView({"_id": "scout"})


@patch("app.routers.sync.emit")
def test_batch_uses_one_insert_and_preserves_event(emit):
    db, user = setup()
    result = sync_scout(SyncIn(entries=[scout(), scout("two", team=2)]), db, user)
    assert result["accepted"] == ["one", "two"]
    assert db.match_scouting.insert_many.call_count == 1
    docs = db.match_scouting.insert_many.call_args.args[0]
    assert {d["event_key"] for d in docs} == {"2026test"}
    assert db.matches.update_many.call_count == 1
    assert emit.call_count == 1


@patch("app.routers.sync.emit")
def test_duplicates_are_acknowledged_without_writing(emit):
    db, user = setup()
    db.match_scouting.find.return_value = [{"client_submission_id": "one", "scouter_id": "scout"}]
    result = sync_scout(SyncIn(entries=[scout()]), db, user)
    assert result["duplicates"] == ["one"]
    db.match_scouting.insert_many.assert_not_called()


@patch("app.routers.sync.emit")
def test_missing_event_is_retained_for_correction(emit):
    db, user = setup()
    result = sync_scout(SyncIn(entries=[scout(event=None)]), db, user)
    assert "one" in result["rejected"]
    assert result["accepted"] == []
    db.match_scouting.insert_many.assert_not_called()


@patch("app.routers.sync.emit")
def test_partial_batch_conflict_does_not_discard_good_entries(emit):
    db, user = setup()
    db.match_scouting.insert_many.side_effect = BulkWriteError({"writeErrors": [{"index": 1, "code": 11000}], "writeConcernErrors": []})
    result = sync_scout(SyncIn(entries=[scout(), scout("two", team=2)]), db, user)
    assert result["accepted"] == ["one"]
    assert "two" in result["rejected"]


@patch("app.routers.sync.emit")
def test_alliance_validation_survives_bulk_optimization(emit):
    db, user = setup()
    db.matches.find.return_value = [{"_id": "2026test_qm1", "alliances": {"red": {"teams": [2]}, "blue": {"teams": [1]}}}]
    result = sync_scout(SyncIn(entries=[scout()]), db, user)
    assert "one" in result["rejected"]
    db.match_scouting.insert_many.assert_not_called()


@patch("app.routers.sync.emit")
def test_replay_recovers_match_lock_without_duplicate_write(emit):
    db, user = setup()
    db.match_scouting.find.return_value = [{"client_submission_id": "one", "scouter_id": "scout", "match_key": "2026test_qm1", "event_key": "2026test"}]
    result = sync_scout(SyncIn(entries=[scout()]), db, user)
    assert result["duplicates"] == ["one"]
    db.match_scouting.insert_many.assert_not_called()
    assert db.matches.update_many.call_count == 1


@patch("app.routers.sync.emit")
def test_other_scouts_uuid_is_not_acknowledged(emit):
    db, user = setup()
    db.match_scouting.find.return_value = [{"client_submission_id": "one", "scouter_id": "other"}]
    result = sync_scout(SyncIn(entries=[scout()]), db, user)
    assert "one" in result["rejected"]
    assert not result["duplicates"]
    db.match_scouting.insert_many.assert_not_called()
