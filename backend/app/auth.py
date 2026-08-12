"""Authentication: sign-in with Scouter ID + shared team password.

The team password is the same for everyone (HazeRain!).  The Scouter ID
identifies the user and ``admin`` is privileged.  Accounts are auto-provisioned
on first successful sign-in (just like the old PurpleScout betting accounts).

Tokens are stateless HMAC-signed blobs — no extra dependency required, and no
datastore round trip to validate one.

Note on Firebase Auth: HazeHub deliberately does **not** use it. Sixty people
share one team password and sign in as "1".."60" on borrowed Chromebooks;
Firebase Auth would mean 60 real accounts to provision and reset, and its
tokens would still have to be mapped onto scouter IDs. Firestore is reached
only by this service through the Admin SDK, so the security rules deny all
client access outright (see ``firestore.rules``) and this token is the only
credential in play.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, Header, HTTPException, status

from . import repo, schema
from .config import settings
from .models import Scouter


def next_s_number() -> int:
    """Sequential scout number (unique across the scouters collection)."""
    return repo.next_s_number()


def _sign(data: bytes) -> str:
    sig = hmac.new(settings.SECRET_KEY.encode(), data, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).decode().rstrip("=")


def create_token(scout_id: str, is_admin: bool) -> str:
    body = {
        "sub": scout_id,
        "admin": is_admin,
        "exp": int(time.time()) + settings.TOKEN_TTL_HOURS * 3600,
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
    except Exception:  # noqa: BLE001
        return None
    if body.get("exp", 0) < time.time():
        return None
    return body


def normalize_id(scout_id: str) -> str:
    """Trim and validate a scouter ID.

    The ID becomes a Firestore document ID, so it has to satisfy Firestore's
    rules (no ``/``, not ``.``/``..``, not ``__*__``, ≤1500 bytes) — checked
    here so a bad login fails with a 400 rather than an opaque write error.
    """
    try:
        return schema.safe_doc_id(scout_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid Scouter ID: {exc}") from exc


def verify_team_password(password: str) -> bool:
    return hmac.compare_digest(password or "", settings.TEAM_PASSWORD)


def get_or_create_scouter(scout_id: str) -> Scouter:
    scout_id = normalize_id(scout_id)
    scouter = repo.scouter(scout_id)
    if scouter is None:
        scouter = Scouter(
            scout_id=scout_id,
            s_number=next_s_number(),
            display_name=scout_id,
            is_admin=(scout_id.lower() == settings.ADMIN_ID.lower()),
            bucks=settings.STARTING_BUCKS,
        )
    scouter.last_seen = datetime.now(timezone.utc)
    repo.save_scouter(scouter)
    repo.touch_presence(scouter.scout_id)
    return scouter


# --- FastAPI dependencies --------------------------------------------------- #
def current_scouter(authorization: str = Header(default="")) -> Scouter:
    token = authorization.removeprefix("Bearer ").strip()
    body = decode_token(token)
    if not body:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not signed in",
        )
    scouter = repo.scouter(body["sub"])
    if scouter is None:
        raise HTTPException(status_code=401, detail="Unknown scouter")
    # Presence is tracked in memory and persisted at most hourly — see
    # repo.touch_presence. Doing it on every request costs nothing.
    repo.touch_presence(scouter.scout_id)
    return scouter


def require_admin(scouter: Scouter = Depends(current_scouter)) -> Scouter:
    if not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    return scouter
