"""Authentication: sign-in with Scouter ID + shared team password.

The team password is the same for everyone.  The Scouter ID identifies the
user and the configured admin ID is privileged.  Accounts are auto-provisioned
on first successful sign-in.

Tokens are stateless HMAC-signed blobs — no extra dependency required, and
nothing server-side to lose between serverless cold starts.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from pymongo.database import Database

from .config import settings
from .database import database_dependency
from .models import ScouterDocument
from .repositories import ConflictError, HazeHubRepository
from .views import ScouterView


def _sign(data: bytes) -> str:
    sig = hmac.new(settings.secret_key.encode(), data, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).decode().rstrip("=")


def create_token(scout_id: str, is_admin: bool) -> str:
    body = {
        "sub": scout_id,
        "admin": is_admin,
        "exp": int(time.time()) + settings.token_ttl_hours * 3600,
    }
    raw = base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")
    return f"{raw}.{_sign(raw.encode())}"


def _b64decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def decode_token(token: str) -> Optional[dict]:
    try:
        raw, sig = token.split(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(sig, _sign(raw.encode())):
        return None
    try:
        body = json.loads(_b64decode(raw))
    except Exception:
        return None
    if body.get("exp", 0) < time.time():
        return None
    return body


def normalize_id(scout_id: str) -> str:
    return scout_id.strip()


def verify_team_password(password: str) -> bool:
    return hmac.compare_digest(password, settings.team_password)


def next_s_number(db: Database) -> int:
    highest = db.scouters.find_one({}, {"s_number": 1}, sort=[("s_number", -1)])
    return int(highest["s_number"] if highest else 0) + 1


def get_or_create_scouter(db: Database, scout_id: str) -> ScouterView:
    scout_id = normalize_id(scout_id)
    now = datetime.now(UTC)
    doc = db.scouters.find_one_and_update(
        {"_id": scout_id},
        {"$set": {"last_seen": now, "updated_at": now}},
    )
    if doc is not None:
        doc["last_seen"] = now
        return ScouterView(doc)

    repo = HazeHubRepository(db)
    scouter = None
    # s_number is a unique sequence; retry a few times if two first-time
    # sign-ins race for the same number.
    for _ in range(5):
        try:
            scouter = repo.create_scouter(
                ScouterDocument(
                    _id=scout_id,
                    s_number=next_s_number(db),
                    display_name=scout_id,
                    is_admin=scout_id.lower() == settings.admin_id.lower(),
                    bucks=settings.starting_bucks,
                )
            )
            break
        except ConflictError:
            existing = db.scouters.find_one({"_id": scout_id})
            if existing is not None:
                scouter = existing
                break
    if scouter is None:
        raise HTTPException(status_code=500, detail="Could not provision account")
    return ScouterView(scouter)


# --- FastAPI dependencies --------------------------------------------------- #
def current_scouter(
    authorization: str = Header(default=""),
    db: Database = Depends(database_dependency),
) -> ScouterView:
    token = authorization.removeprefix("Bearer ").strip()
    body = decode_token(token)
    if not body:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not signed in",
        )
    scouter = db.scouters.find_one({"_id": body["sub"]})
    if scouter is None:
        raise HTTPException(status_code=401, detail="Unknown scouter")
    return ScouterView(scouter)


def require_admin(scouter: ScouterView = Depends(current_scouter)) -> ScouterView:
    if not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    return scouter
