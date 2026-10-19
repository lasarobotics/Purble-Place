"""Roster migration, first-use passwords, and the event permission boundary."""
from copy import deepcopy
import base64
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import auth, repo, seed
from app.config import settings
from app.models import Scouter
from app.routers import auth as auth_routes, admin, system, forms, seasons, picklists


@pytest.fixture
def accounts(monkeypatch):
    rows = {}
    values = {}
    monkeypatch.setattr(repo, "scouter", lambda key: deepcopy(rows.get(key)))
    monkeypatch.setattr(repo, "scouters", lambda: deepcopy(list(rows.values())))
    monkeypatch.setattr(repo, "save_scouter", lambda s: rows.__setitem__(s.scout_id, deepcopy(s)))
    monkeypatch.setattr(repo, "save_scouters", lambda items: [repo.save_scouter(s) for s in items])
    monkeypatch.setattr(repo, "next_s_number", lambda: 1)
    monkeypatch.setattr(repo, "touch_presence", lambda key: None)
    monkeypatch.setattr(repo, "setting", lambda key: values.get(key, ""))
    monkeypatch.setattr(repo, "set_setting", lambda key, value: values.__setitem__(key, value))
    monkeypatch.setattr(seed.store, "delete", lambda collection, key: rows.pop(key, None))
    return rows


@pytest.fixture
def client(accounts):
    seed.seed()
    app = FastAPI()
    for module in [auth_routes, admin, system, forms, seasons, picklists]:
        app.include_router(module.router)
    return TestClient(app)


def enroll(client, password="Unique-for-Haze-123"):
    return client.post("/api/auth/setup", json={"scout_id": "10217860", "password": password, "password_confirmation": password})


def test_migration_preserves_existing_users_and_is_repeatable(accounts):
    accounts.update({"admin": Scouter("admin", role="admin", bucks=321), "Strategy": Scouter("Strategy", role="strategy"), "1": Scouter("1")})
    seed.seed()
    assert set(accounts) == set(settings.ACCOUNTS) | {"Strategy", "1"}
    assert accounts["Admin"].bucks == 321
    assert sum(s.is_admin for s in accounts.values()) == 1
    accounts["10217860"].password_hash = auth.hash_password("personal-password")
    expected = deepcopy(accounts)
    seed.seed()
    assert accounts == expected


def test_first_use_and_personal_login(client, accounts):
    assert client.post("/api/auth/account-status", json={"scout_id": "10217860"}).json() == {"needs_setup": True}
    for password in ["10217860", settings.TEAM_PASSWORD]:
        assert client.post("/api/auth/login", json={"scout_id": "10217860", "team_password": password}).status_code == 401
    result = enroll(client)
    assert result.status_code == 200
    assert "password_hash" not in result.json()
    assert accounts["10217860"].password_hash.startswith("scrypt$")
    assert client.post("/api/auth/account-status", json={"scout_id": "10217860"}).json() == {"needs_setup": False}
    assert enroll(client, "replacement-password").status_code == 409
    login = client.post("/api/auth/login", json={"scout_id": "10217860", "team_password": "Unique-for-Haze-123"})
    assert login.status_code == 200
    assert login.json()["is_admin"] is False
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + result.json()["token"]}).status_code == 200


def test_navigation_and_reloaded_account_cache_keep_session_valid(client, accounts):
    token = enroll(client).json()["token"]
    headers = {"Authorization": "Bearer " + token}
    # Reconstruct persisted account objects as a normal deployment/cache load does.
    restored = deepcopy(accounts)
    accounts.clear()
    accounts.update(restored)
    repo.invalidate_memo()
    for _ in range(3):
        assert client.get("/api/auth/me", headers=headers).status_code == 200
    accounts["10217860"].password_hash = auth.hash_password("changed-password")
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_unavailable_account_cache_does_not_revoke_valid_session(client, accounts, monkeypatch):
    token = enroll(client).json()["token"]
    accounts.clear()
    monkeypatch.setattr(repo.store, "ready", False)
    monkeypatch.setattr(repo.store, "error", "unavailable")
    headers = {"Authorization": "Bearer " + token}
    assert client.get("/api/auth/me", headers=headers).status_code == 503
    monkeypatch.setattr(repo.store, "ready", True)
    assert client.get("/api/auth/me", headers=headers).status_code == 401


@pytest.mark.parametrize("scout_id,password,confirmation,status", [
    ("10217860", "long-password", "different-password", 400),
    ("10217860", "short", "short", 400),
    ("10217860", "x" * 129, "x" * 129, 400),
    ("Demo", "long-password", "long-password", 403),
    ("Admin", "long-password", "long-password", 409),
])
def test_invalid_setup(client, scout_id, password, confirmation, status):
    response = client.post("/api/auth/setup", json={"scout_id": scout_id, "password": password, "password_confirmation": confirmation})
    assert response.status_code == status


def test_permission_boundary_and_deleted_sessions(client, accounts):
    token = enroll(client).json()["token"]
    headers = {"Authorization": "Bearer " + token}
    for path in ["settings", "system-health", "scouters", "firestore-usage", "archives"]:
        assert client.get("/api/admin/" + path, headers=headers).status_code == 403
    assert client.post("/api/admin/event", headers=headers, json={"event_key": "x"}).status_code == 403
    assert client.get("/api/admin/metrics", headers=headers).status_code == 200
    assert client.get("/api/admin/metrics").status_code == 401
    # A forged stored role does not elevate a roster member.
    accounts["10217860"].role = "admin"
    assert client.get("/api/admin/settings", headers=headers).status_code == 403
    del accounts["10217860"]
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_admin_cannot_create_second_admin(client):
    response = client.post("/api/auth/login", json={"scout_id": "admin", "team_password": settings.TEAM_PASSWORD})
    assert response.status_code == 200
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    assert client.get("/api/admin/metrics", headers=headers).status_code == 200
    assert client.post("/api/admin/scouters/10217860/role", headers=headers, json={"role": "admin"}).status_code == 400


def test_admin_reset_returns_member_to_first_use_setup(client, accounts):
    enroll(client)
    admin = client.post("/api/auth/login", json={"scout_id": "admin", "team_password": settings.TEAM_PASSWORD})
    headers = {"Authorization": "Bearer " + admin.json()["token"]}

    reset = client.post(
        "/api/admin/scouters/password-reset",
        headers=headers,
        json={"scout_id": "10217860"},
    )
    assert reset.status_code == 200
    assert accounts["10217860"].password_hash == ""
    assert client.post("/api/auth/login", json={"scout_id": "10217860", "team_password": "Unique-for-Haze-123"}).status_code == 401
    assert client.post("/api/auth/account-status", json={"scout_id": "10217860"}).json() == {"needs_setup": True}

    replacement = client.post("/api/auth/setup", json={
        "scout_id": "10217860",
        "password": "Replacement-password-456",
        "password_confirmation": "Replacement-password-456",
    })
    assert replacement.status_code == 200
    assert accounts["10217860"].password_hash.startswith("scrypt$")


def test_password_reset_is_admin_only_and_cannot_reset_admin(client):
    member_token = enroll(client).json()["token"]
    member_headers = {"Authorization": "Bearer " + member_token}
    assert client.post(
        "/api/admin/scouters/password-reset",
        headers=member_headers,
        json={"scout_id": "10217860"},
    ).status_code == 403

    admin = client.post("/api/auth/login", json={"scout_id": "admin", "team_password": settings.TEAM_PASSWORD})
    admin_headers = {"Authorization": "Bearer " + admin.json()["token"]}
    assert client.post(
        "/api/admin/scouters/password-reset",
        headers=admin_headers,
        json={"scout_id": "Admin"},
    ).status_code == 400
    assert client.post(
        "/api/admin/scouters/password-reset",
        headers=admin_headers,
        json={"scout_id": "not-on-roster"},
    ).status_code == 404


def test_old_tokens_are_revoked():
    raw = base64.urlsafe_b64encode(json.dumps({"sub": "Admin", "exp": time.time() + 600}).encode()).decode().rstrip("=")
    assert auth.decode_token(raw + "." + auth._sign(raw.encode())) is None


def test_password_model_roundtrip():
    row = Scouter("10217860", password_hash=auth.hash_password("unique-password"))
    restored = Scouter.from_doc(row.scout_id, row.to_doc())
    assert auth.verify_password("unique-password", restored.password_hash)
    assert not auth.verify_password("incorrect", restored.password_hash)


def test_offline_provision_requires_fresh_own_password_and_exports_no_verifier(client):
    session = enroll(client).json()
    headers = {"Authorization": "Bearer " + session["token"]}
    body = {"scout_id": "10217860", "team_password": "Unique-for-Haze-123"}
    assert client.post("/api/auth/offline-provision", json=body).status_code == 401
    response = client.post("/api/auth/offline-provision", json=body, headers=headers)
    assert response.status_code == 200
    grant = response.json()
    assert set(grant) == {"version", "scout_id", "s_number", "display_name", "issued_at", "expires_at"}
    assert grant["expires_at"] - grant["issued_at"] == 86400_000
    assert client.post("/api/auth/offline-provision", json={**body, "team_password": "incorrect"}, headers=headers).status_code == 401
    assert client.post("/api/auth/offline-provision", json={**body, "scout_id": "Admin"}, headers=headers).status_code == 403
    admin = client.post("/api/auth/login", json={"scout_id": "Admin", "team_password": settings.TEAM_PASSWORD}).json()
    assert client.post("/api/auth/offline-provision", json={"scout_id": "Admin", "team_password": settings.TEAM_PASSWORD}, headers={"Authorization": "Bearer " + admin["token"]}).status_code == 403


def test_password_change_invalidates_old_tokens_even_after_new_password_setup(client, accounts):
    session = enroll(client).json()
    accounts["10217860"].password_hash = auth.hash_password("replacement-password")
    headers = {"Authorization": "Bearer " + session["token"]}
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    new = client.post("/api/auth/login", json={"scout_id": "10217860", "team_password": "replacement-password"}).json()
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + new["token"]}).status_code == 200


def test_cookie_restores_identity_but_does_not_authorize_mutations(client):
    response = enroll(client)
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=lax" in response.headers["set-cookie"]
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/api/auth/me").status_code == 200
    assert client.post("/api/auth/offline-provision", json={"scout_id": "10217860", "team_password": "Unique-for-Haze-123"}).status_code == 401
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
