"""Guardrails for manual schedules, scouting identity, and pit photos."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import auth, repo
from app.models import MatchRecord, Scouter
from app.routers import admin, scouting


@pytest.fixture
def admin_client(monkeypatch):
    app = FastAPI()
    app.include_router(admin.router)
    user = Scouter("Admin", role="admin", display_name="Admin")
    app.dependency_overrides[auth.current_scouter] = lambda: user
    monkeypatch.setattr(repo, "touch_presence", lambda *_: None)
    return TestClient(app)


def test_scouting_rejects_nonpositive_identity_fields():
    good = {"match_number": 1, "team_number": 418, "station": 1,
            "alliance": "red", "comp_level": "qm"}
    assert scouting.validate_submission({**good, "match_number": 0}) == "match_number must be at least 1"
    assert scouting.validate_submission({**good, "team_number": -418}) == "team_number must be at least 1"


def test_csv_schedule_is_fully_validated_before_replace(admin_client, monkeypatch):
    saved = []
    monkeypatch.setattr(repo, "replace_event_schedule", lambda event, rows: saved.append((event, rows)))
    csv_text = "match_number,red1,red2,red3,blue1,blue2,blue3\n1,418,436,254,148,118,3005\n"
    response = admin_client.post("/api/admin/schedule/csv", json={"event_key": "2026txman", "csv_text": csv_text})
    assert response.status_code == 200
    assert response.json()["matches"] == 1
    assert saved[0][0] == "2026txman"
    assert saved[0][1][0].red == [418, 436, 254]

    duplicate = "match_number,red1,red2,red3,blue1,blue2,blue3\n1,418,418,254,148,118,3005\n"
    response = admin_client.post("/api/admin/schedule/csv", json={"event_key": "2026txman", "csv_text": duplicate})
    assert response.status_code == 400
    assert len(saved) == 1  # invalid input did not touch the prior schedule


def test_current_match_cannot_be_zero(admin_client):
    assert admin_client.post("/api/admin/current-match", json={"match_number": 0}).status_code == 422


def test_pit_team_must_be_on_event_schedule(monkeypatch):
    app = FastAPI()
    app.include_router(scouting.pit_router)
    user = Scouter("1", display_name="Scout")
    app.dependency_overrides[auth.current_scouter] = lambda: user
    monkeypatch.setattr(repo, "touch_presence", lambda *_: None)
    monkeypatch.setattr(repo, "resolve_event", lambda event=None: event or "2026txman")
    match = MatchRecord("2026txman_qm1", "2026txman", match_number=1)
    match.set_alliances([418, 436, 254], [148, 118, 3005])
    monkeypatch.setattr(repo, "matches_for_event", lambda event: [match])
    monkeypatch.setattr(repo, "pit", lambda event, team: None)
    saved = []
    monkeypatch.setattr(repo, "save_pit_with_photos", lambda row, photos: saved.append((row, photos)))
    client = TestClient(app)

    bad = client.post("/api/pit", json={"event_key": "2026txman", "team_number": 9999, "answers": {}})
    assert bad.status_code == 400
    assert saved == []
    good = client.post("/api/pit", json={
        "event_key": "2026txman", "team_number": 418,
        "answers": {"robot_photo": ["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]},
    })
    assert good.status_code == 200
    assert saved[0][0].team_number == 418
    assert len(saved[0][1]) == 2


def test_pit_numeric_bounds_are_enforced(monkeypatch):
    app = FastAPI(); app.include_router(scouting.pit_router)
    app.dependency_overrides[auth.current_scouter] = lambda: Scouter("1")
    monkeypatch.setattr(repo, "touch_presence", lambda *_: None)
    client = TestClient(app)
    assert client.post("/api/pit", json={"team_number": -1}).status_code == 422
    assert client.post("/api/pit", json={"team_number": 418, "weight_lbs": -2}).status_code == 422
