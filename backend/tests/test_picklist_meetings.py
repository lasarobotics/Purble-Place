from copy import deepcopy
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import picklist_service as svc, repo, auth
from app.cache import LocalBackend
from app.models import Scouter, Picklist
from app.routers.picklists import router

@pytest.fixture
def env(tmp_path, monkeypatch):
    backend = LocalBackend(tmp_path / "test.json")
    monkeypatch.setattr(repo.store, "backend", backend)
    monkeypatch.setattr(repo, "resolve_event", lambda event=None: event or "event-a")
    monkeypatch.setattr(repo, "scouter", lambda key: Scouter(key, display_name="Alex Scout"))
    monkeypatch.setattr(svc, "emit", lambda *args: None)
    svc._cache.clear(); svc._presence.clear()
    app = FastAPI(); app.include_router(router)
    user = [Scouter("scout-a", display_name="Alex Scout")]
    app.dependency_overrides[auth.current_scouter] = lambda: user[0]
    yield TestClient(app), user, backend
    svc._cache.clear(); svc._presence.clear()

def admin(user):
    user[0] = Scouter("Admin", role="admin", display_name="Admin")

def draft(c, event="event-a"):
    row = c.get(f"/api/picklists/mine?event={event}").json()[0]
    r = c.put(f"/api/picklists/{row['id']}", json=dict(row, items=[{"team": 418}, {"team": 436}]))
    assert r.status_code == 200, r.text
    return r.json()

def submit(c, row, token="retry"):
    r = c.post(f"/api/picklists/{row['id']}/submit", json=dict(row, name="Alex_FirstPick", owner_name="Alex Scout", request_id=token))
    assert r.status_code == 200, r.text
    return r.json()

def action(c, kind, data=None, event="event-a", version=None):
    state = c.get(f"/api/picklists/meeting?event={event}").json()
    return c.post("/api/picklists/meeting", json={"event_key": event, "version": state["version"] if version is None else version, "action": kind, "data": data or {}})

def test_immutable_submissions_retry_copy_and_restart(env):
    c, u, _ = env
    row = draft(c); first = submit(c, row)
    assert submit(c, row)["id"] == first["id"]
    assert len(c.get("/api/picklists/submissions").json()) == 1
    updated = c.put(f"/api/picklists/{row['id']}", json=dict(row, items=[{"team": 999}])).json()
    assert submit(c, updated, "new")["submission_number"] == 2
    admin(u); action(c, "start")
    assert action(c, "import", {"pick_round": 1, "source_id": first["id"]}).status_code == 200
    assert action(c, "edit", {"pick_round": 1, "items": [{"team": 254}]}).status_code == 200
    originals = c.get("/api/picklists/submissions?search=alex").json()
    assert next(r for r in originals if r["id"] == first["id"])["items"][0]["team"] == 418
    svc._cache.clear()
    assert c.get("/api/picklists/meeting").json()["boards"][0]["items"][0]["team"] == 254
    assert len(c.get("/api/picklists/submissions").json()) == 2

def test_picklist_workspace_has_switchable_first_and_second_pick_tabs(env):
    c, _, _ = env
    response = c.post("/api/picklists/workspace", json={
        "event_key": "event-a", "name": "Drive Team Plan", "robot_number": 418, "robot_name": "Purple Haze",
        "first_items": [{"team": 254}], "second_items": [{"team": 436}],
    })
    assert response.status_code == 200, response.text
    rows = response.json()
    assert [row["pick_round"] for row in rows] == [1, 2]
    assert rows[0]["workspace_id"] == rows[1]["workspace_id"]
    assert rows[0]["items"][0]["team"] == 254
    assert rows[1]["items"][0]["team"] == 436
    deleted = c.delete(f"/api/picklists/workspace/{rows[0]['workspace_id']}?event=event-a")
    assert deleted.status_code == 200
    remaining = c.get("/api/picklists/mine?event=event-a").json()
    assert all(row.get("workspace_id") != rows[0]["workspace_id"] for row in remaining)

@pytest.mark.parametrize("kind", ["start","pause","resume","end","reset","clear_temporary","lock","view","select","edit","edit_boards","import","restore","undo","redo","team","publish","unpublish"])
def test_all_meeting_actions_require_designated_admin(env, kind):
    c, u, _ = env
    assert action(c, kind).status_code == 403
    u[0] = Scouter("OtherAdmin", role="admin")
    assert action(c, kind).status_code == 403

@pytest.mark.parametrize("path,method", [("all","get"),("history","get"),("delete","post"),("reset","post")])
def test_privileged_routes(env, path, method):
    c, _, _ = env
    assert getattr(c, method)(f"/api/picklists/{path}", **({"json":{}} if method == "post" else {})).status_code == 403

def test_ownership_validation_and_stale_draft(env):
    c, u, _ = env
    row = draft(c)
    for items in [[{"team":418},{"team":418}],[{"team":-1}]]:
        assert c.put(f"/api/picklists/{row['id']}", json=dict(row, items=items)).status_code == 400
    assert c.put(f"/api/picklists/{row['id']}", json=dict(row, version=0)).status_code == 409
    u[0] = Scouter("another")
    assert c.put(f"/api/picklists/{row['id']}", json=row).status_code == 403
    assert c.post(f"/api/picklists/{row['id']}/submit", json=dict(row, request_id="stolen")).status_code == 403
    assert c.get("/api/picklists/submissions").json() == []

def test_pause_lock_conflict_undo_restore(env):
    c, u, _ = env
    row = draft(c); admin(u); action(c, "start")
    stale = c.get("/api/picklists/meeting").json()["version"]
    assert action(c,"edit",{"pick_round":1,"items":[{"team":418}]}).status_code == 200
    assert action(c,"edit",{"pick_round":1,"items":[]},version=stale).status_code == 409
    assert action(c,"undo").json()["boards"][0]["items"] == []
    assert action(c,"redo").json()["boards"][0]["items"][0]["team"] == 418
    entry = c.get("/api/picklists/history").json()["entries"][0]
    action(c,"pause")
    assert action(c,"edit",{"pick_round":1,"items":[]}).status_code == 409
    action(c,"resume")
    assert action(c,"restore",{"id":entry["id"]}).status_code == 200
    action(c,"lock",{"locked":True}); u[0] = Scouter("scout-a")
    assert c.post(f"/api/picklists/{row['id']}/submit",json=dict(row,request_id="locked")).status_code == 423

def test_publish_history_reset_and_events(env):
    c,u,_ = env
    submit(c,draft(c)); admin(u); action(c,"start")
    assert action(c,"edit_boards",{"boards":{"1":[{"team":418}],"2":[{"team":436}]}}).status_code == 200
    assert action(c,"publish").status_code == 200
    assert len(c.get("/api/picklists/finals").json()) == 2
    assert c.get("/api/picklists/finals?event=event-b").json() == []
    action(c,"edit",{"pick_round":1,"items":[{"team":999}]}); action(c,"publish")
    history = [r for r in c.get("/api/picklists/history").json()["entries"] if r["action"] == "publish"]
    assert len(history) == 2
    assert history[-1]["published"]["boards"][0]["items"][0]["team"] == 418
    action(c,"end"); action(c,"reset")
    assert c.get("/api/picklists/meeting").json()["status"] == "not_started"
    assert len(c.get("/api/picklists/submissions").json()) == 1
    assert len(c.get("/api/picklists/finals").json()) == 2

def test_atomic_failure_deletion_and_scoped_reset(env,monkeypatch):
    c,u,b = env
    row = draft(c); other = draft(c,"event-b")
    b.commit([("set","match_scouting","safe",{"event_key":"event-a","points":99})]); admin(u)
    original = b.commit
    monkeypatch.setattr(b,"commit",lambda ops: (_ for _ in ()).throw(OSError("offline")))
    assert c.post("/api/picklists/delete",json={"ids":[row["id"]]}).status_code == 503
    assert any(r["id"] == row["id"] for r in c.get("/api/picklists/all").json())
    monkeypatch.setattr(b,"commit",original); action(c,"start")
    assert c.post("/api/picklists/delete",json={"ids":[row["id"]]}).status_code == 409
    assert c.post("/api/picklists/reset",json={"confirmation":"RESET PICKLISTS"}).status_code == 409
    action(c,"end")
    assert c.post("/api/picklists/reset",json={"confirmation":"wrong"}).status_code == 400
    assert c.post("/api/picklists/reset",json={"confirmation":"RESET PICKLISTS"}).status_code == 200
    svc._cache.clear()
    assert c.get("/api/picklists/all").json() == []
    assert any(r["id"] == other["id"] for r in c.get("/api/picklists/all?event=event-b").json())
    assert b.get("match_scouting","safe")["points"] == 99

def test_legacy_migration_and_cross_event_import(env):
    c,u,b = env
    legacy = Picklist(event_key="event-a",owner_id="scout-a",name="Existing",items=[{"team":418}])
    b.commit([("set","picklists",legacy.doc_id,legacy.to_doc())])
    assert any(r["name"] == "Existing" for r in c.get("/api/picklists/mine").json())
    assert b.get("picklists",legacy.doc_id)["picklist_name"] == "Existing"
    assert c.get("/api/picklists/submissions").json() == []
    foreign = submit(c,draft(c,"event-b")); admin(u); action(c,"start")
    assert action(c,"import",{"source_id":foreign["id"],"pick_round":1}).status_code == 400
    assert action(c,"edit_boards",{"boards":{"1":[{"team":418}],"2":[{"team":9},{"team":9}]}}).status_code == 400
    assert c.get("/api/picklists/meeting").json()["boards"][0]["items"] == []

def test_unlimited_drafts_destination_team_numbering_and_delete(env):
    c, _, _ = env
    first = c.post("/api/picklists", json={"event_key":"event-a","name":"Option A","pick_round":1,"robot_number":436,"robot_name":"Purple Rain","items":[{"team":418}]}).json()
    second = c.post("/api/picklists", json={"event_key":"event-a","name":"Option A","pick_round":1,"robot_number":436,"robot_name":"Purple Rain","items":[{"team":254}]}).json()
    assert first["id"] != second["id"]
    assert len([r for r in c.get("/api/picklists/mine").json() if r["pick_round"] == 1]) >= 2
    bad = c.post(f"/api/picklists/{first['id']}/submit", json=dict(first, robot_number=0, request_id="bad"))
    assert bad.status_code == 400
    missing_team = dict(first, request_id="missing-team")
    missing_team.pop("robot_number")
    assert c.post(f"/api/picklists/{first['id']}/submit", json=missing_team).status_code == 422
    one = submit(c, first, "one")
    two = submit(c, second, "two")
    assert (one["submission_number"], two["submission_number"]) == (1, 2)
    assert one["owner_name"] == "Alex Scout" and one["robot_number"] == 436 and one["submitted_at"]
    assert c.delete(f"/api/picklists/{first['id']}?event=event-a").status_code == 200
    assert c.delete(f"/api/picklists/{one['id']}?event=event-a").status_code == 403

def test_multi_robot_boards_shared_presentation_and_comparison_limit(env):
    c, u, _ = env
    rows = []
    for index in range(9):
        row = c.post("/api/picklists", json={"event_key":"event-a","name":f"List {index}","pick_round":1,"items":[{"team":100 + index}]}).json()
        rows.append(submit(c, row, f"token-{index}"))
    admin(u); action(c, "start")
    added = action(c, "add_robot", {"robot_number":999,"name":"Practice Bot"}).json()
    assert added["active_robot"] == 999 and len(added["boards"]) == 6
    state = action(c, "present", {"type":"comparison","comparison_ids":[r["id"] for r in rows[:8]]}).json()
    assert state["presentation"]["comparison_ids"] == [r["id"] for r in rows[:8]]
    assert c.post("/api/picklists/compare", json={"event_key":"event-a","ids":[r["id"] for r in rows],"pick_round":1}).status_code == 400
