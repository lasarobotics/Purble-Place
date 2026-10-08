from unittest.mock import MagicMock
import pytest
from app.routers import sync as s
from app.routers.scouting import ScoutIn
from app.models import Scouter

@pytest.fixture
def env(monkeypatch):
    stored={}
    def create(entry):
        if entry.submission_id in stored: return False
        stored[entry.submission_id]=entry
        return True
    writer=MagicMock(side_effect=create)
    monkeypatch.setattr(s.repo,"create_scouting",writer)
    monkeypatch.setattr(s.repo,"scouting_by_submission",stored.get)
    monkeypatch.setattr(s.repo,"save_scouter",MagicMock())
    monkeypatch.setattr(s,"lock_betting_for_match",MagicMock())
    monkeypatch.setattr(s,"emit",MagicMock())
    return stored,writer,Scouter(scout_id="test")

def scout(id="one",event="test",team=1,**kwargs):
    return ScoutIn(client_uuid=id,event_key=event,team_number=team,match_number=1,**kwargs)

def test_replay_has_no_second_write(env):
    stored,writer,user=env
    body=s.SyncIn(entries=[scout()])
    assert s.sync_scout(body,user)["accepted"] == ["one"]
    assert s.sync_scout(body,user)["duplicates"] == ["one"]
    assert writer.call_count == 1

def test_missing_event_does_not_reassign_offline_report(env):
    _,writer,user=env
    result=s.sync_scout(s.SyncIn(entries=[scout(event=None)]),user)
    assert result["results"][0]["status"] == "invalid"
    writer.assert_not_called()

def test_transient_failure_remains_retryable(env):
    _,writer,user=env
    writer.side_effect=RuntimeError("offline")
    result=s.sync_scout(s.SyncIn(entries=[scout()]),user)
    assert result["results"][0]["status"] == "retry"
    assert result["accepted"] == []

def test_batch_isolates_invalid_and_locks_match_once(env):
    stored,writer,user=env
    result=s.sync_scout(s.SyncIn(entries=[scout(),scout("two",team=2),scout("bad",team=0)]),user)
    assert result["accepted"] == ["one","two"]
    assert result["results"][2]["status"] == "invalid"
    assert s.lock_betting_for_match.call_count == 1
    assert s.repo.save_scouter.call_count == 1
    assert s.emit.call_count == 1

def test_same_uuid_different_payload_cannot_overwrite(env):
    stored,writer,user=env
    result=s.sync_scout(s.SyncIn(entries=[scout(payload_hash="a"),scout(payload_hash="b")]),user)
    assert result["results"][1]["status"] == "conflict"
    assert stored["one"].payload_hash == "a"
