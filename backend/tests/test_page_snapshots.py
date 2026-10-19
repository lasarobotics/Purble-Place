from copy import deepcopy
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import auth, repo, schema
from app.cache import Store
from app.models import Scouter
from app.routers import accounts, pages
from test_cache import RecordingBackend


def test_snapshot_304_skips_builder_and_scopes_account(monkeypatch):
    store = Store()
    monkeypatch.setattr(repo, "store", store)
    app = FastAPI()
    user = Scouter("a")
    calls = []
    @app.get("/snapshot")
    def get(request: __import__('fastapi').Request):
        return pages.snapshot(request, user, "analysis:event", lambda: calls.append(1) or {"ok": True})
    client = TestClient(app)
    first = client.get("/snapshot")
    assert first.headers["cache-control"] == "private, no-cache"
    headers = {"If-None-Match": first.headers["etag"]}
    assert client.get("/snapshot", headers=headers).status_code == 304
    assert calls == [1]
    user.scout_id = "b"
    assert client.get("/snapshot", headers=headers).status_code == 200
    user.scout_id = "a"
    store._revision[schema.SCOUTERS] += 1
    assert client.get("/snapshot", headers=headers).status_code == 200


def test_account_lifecycle_audits_preserves_history_and_revokes(monkeypatch):
    store = Store(); store.backend = RecordingBackend(); store.ready = True
    monkeypatch.setattr(repo, "store", store)
    monkeypatch.setattr(accounts, "emit", lambda *args: None)
    admin = Scouter("Admin", role="admin")
    app = FastAPI(); app.include_router(accounts.router)
    app.dependency_overrides[auth.require_full_admin] = lambda: admin
    app.dependency_overrides[auth.current_scouter] = lambda: repo.scouter("new")
    client = TestClient(app)
    response = client.post("/api/admin/accounts", json={"scout_id":"new", "s_number":999})
    assert response.status_code == 200
    assert "password_hash" not in response.json()
    row = repo.scouter("new"); row.password_hash = auth.hash_password("long-password")
    store.atomic_replace([row], [])
    before = auth.credential_revision(row)
    assert client.put("/api/auth/profile", json={"display_name":" Alex "}).json()["name_confirmed"]
    assert repo.scouter("new").display_name == "Alex"
    assert client.patch("/api/admin/accounts/new",json={"action":"role","role":"admin"}).status_code == 422
    assert client.patch("/api/admin/accounts/new",json={"action":"delete"}).status_code == 400
    assert client.patch("/api/admin/accounts/new",json={"action":"delete","confirmation":"new"}).status_code == 200
    assert repo.scouter("new").deleted
    assert before != auth.credential_revision(repo.scouter("new"))
    assert client.patch("/api/admin/accounts/new",json={"action":"enable"}).status_code == 200
    assert not repo.scouter("new").deleted
    assert len([key for key in store.backend.docs if key[0] == schema.ACCOUNT_AUDIT]) == 4


def test_atomic_account_change_cancels_pending_old_account():
    store = Store(); store.backend = RecordingBackend(); store.ready = True
    old = Scouter("a", matches_scouted=4)
    store.coalesce(old, delay_s=-1)
    updated = deepcopy(old); updated.active = False; updated.auth_revision = 1
    store.atomic_replace([updated], [])
    assert store.flush() == 0
    assert not store.backend.docs[(schema.SCOUTERS,"a")]["active"]
