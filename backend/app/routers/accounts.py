"""Audited account lifecycle. Historical reports keep their immutable author IDs."""
from copy import deepcopy
from datetime import datetime, timezone
from threading import RLock
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from .. import repo
from ..auth import current_scouter, require_full_admin, normalize_id
from ..models import Scouter, AccountAuditDocument
from ..realtime import emit

router = APIRouter(tags=["accounts"])
lock = RLock()


def public(row):
    return {key: getattr(row, key) for key in ("scout_id", "s_number", "display_name", "role", "active", "deleted", "name_confirmed")}


def save(account, actor, action):
    audit = AccountAuditDocument(uuid4().hex, {"account_id": account.scout_id, "actor_id": actor.scout_id,
        "action": action, "at": datetime.now(timezone.utc).isoformat(), "account": public(account)})
    repo.store.atomic_replace([account, audit], [])
    emit("accounts_changed", {})


class NameIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)


@router.put("/api/auth/profile")
def profile(body: NameIn, user: Scouter = Depends(current_scouter)):
    name = body.display_name.strip()
    if not name: raise HTTPException(422, "Enter your name")
    with lock:
        account = deepcopy(repo.scouter(user.scout_id))
        account.display_name, account.name_confirmed = name, True
        save(account, user, "display_name")
    return public(account)


class AccountIn(BaseModel):
    scout_id: str
    s_number: int = Field(ge=1)
    display_name: str = Field(default="", max_length=80)
    role: str = "scouter"


class ChangeIn(BaseModel):
    action: str
    role: str | None = None
    confirmation: str = ""


@router.get("/api/admin/accounts")
def accounts(_: Scouter = Depends(require_full_admin)):
    return [public(s) for s in repo.scouters()]


@router.post("/api/admin/accounts")
def create(body: AccountIn, user: Scouter = Depends(require_full_admin)):
    if body.role not in ("scouter", "strategy", "picklist"): raise HTTPException(422, "Choose an allowed role")
    key = normalize_id(body.scout_id)
    with lock:
        if any(s.scout_id.casefold() == key.casefold() or s.s_number == body.s_number for s in repo.scouters()):
            raise HTTPException(409, "Account ID or S-number already exists")
        row = Scouter(key, s_number=body.s_number, display_name=body.display_name.strip(), role=body.role)
        save(row, user, "created")
    return public(row)


@router.patch("/api/admin/accounts/{account_id}")
def change(account_id: str, body: ChangeIn, user: Scouter = Depends(require_full_admin)):
    with lock:
        original = repo.scouter(account_id)
        if original is None: raise HTTPException(404, "Account not found")
        if account_id == "Admin": raise HTTPException(403, "The primary Admin cannot be disabled or reassigned")
        row = deepcopy(original)
        if body.action == "role":
            if body.role not in ("scouter", "strategy", "picklist"): raise HTTPException(422, "Choose an allowed role")
            row.role = body.role
        elif body.action in ("disable", "delete"):
            if body.action == "delete" and body.confirmation != account_id: raise HTTPException(400, "Type the account ID to confirm")
            row.active = False
            row.deleted = body.action == "delete"
        elif body.action == "enable": row.active, row.deleted = True, False
        elif body.action == "reset_password": row.password_hash = ""
        else: raise HTTPException(422, "Unknown action")
        row.auth_revision += 1
        save(row, user, body.action)
    emit("password_reset", {"scout_id": row.scout_id})
    return public(row)
