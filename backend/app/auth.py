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

from fastapi import Depends, Header, HTTPException, Request, status

from . import repo, schema
from .config import settings
from .models import ADMIN_ROLES, ROLE_ADMIN, ROLE_PICKLIST, ROLE_SCOUTER, ROLE_STRATEGY, Scouter


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


def role_for_new_account(scout_id: str) -> str:
    """The role a brand new account starts with, from configuration."""
    key = scout_id.lower()
    if key in settings.ADMIN_IDS:
        return ROLE_ADMIN
    if key in settings.STRATEGY_IDS:
        return ROLE_STRATEGY
    if key in settings.PICKLIST_IDS:
        return ROLE_PICKLIST
    return ROLE_SCOUTER


def get_or_create_scouter(scout_id: str) -> Scouter:
    scout_id = normalize_id(scout_id)
    scouter = repo.scouter(scout_id)
    if scouter is None:
        scouter = Scouter(
            scout_id=scout_id,
            s_number=next_s_number(),
            display_name=scout_id,
            role=role_for_new_account(scout_id),
            bucks=settings.STARTING_BUCKS,
        )
    scouter.last_seen = datetime.now(timezone.utc)
    repo.save_scouter(scouter)
    repo.touch_presence(scouter.scout_id)
    return scouter


# --------------------------------------------------------------------------- #
# What a picklist account is allowed to reach                                  #
# --------------------------------------------------------------------------- #
#: A picklist account runs on the shared screen during a picklist meeting.
#: It can read team data and edit picklists, and nothing else, so that a
#: mis-tap on a projector cannot advance the match, settle bets or change the
#: event. Enforced centrally rather than route by route, because the failure
#: mode of forgetting one route is silent.
PICKLIST_ALLOWED_PREFIXES = (
    "/api/auth",
    "/api/picklists",
    "/api/teams",
    "/api/events",
    "/api/health",
    "/api/matches",
)


def _picklist_account_may_reach(path: str) -> bool:
    return any(path.startswith(prefix) for prefix in PICKLIST_ALLOWED_PREFIXES)


# --- FastAPI dependencies --------------------------------------------------- #
def current_scouter(
    request: Request, authorization: str = Header(default="")
) -> Scouter:
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
    if scouter.picklist_only and not _picklist_account_may_reach(request.url.path):
        raise HTTPException(
            status_code=403,
            detail="This is a picklist meeting account. It can only view teams "
            "and edit picklists. Sign in with your own account for anything else.",
        )
    # Presence is tracked in memory and persisted at most hourly — see
    # repo.touch_presence. Doing it on every request costs nothing.
    repo.touch_presence(scouter.scout_id)
    return scouter


def require_admin(scouter: Scouter = Depends(current_scouter)) -> Scouter:
    """Admin and strategy accounts. They have identical permissions; the two
    names exist so picklist priority can tell them apart."""
    if scouter.role not in ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Admin or strategy only")
    return scouter


def require_full_admin(scouter: Scouter = Depends(current_scouter)) -> Scouter:
    """Admin only. Used for the few actions strategy should not perform,
    such as changing someone else's role."""
    if scouter.role != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Admin only")
    return scouter
