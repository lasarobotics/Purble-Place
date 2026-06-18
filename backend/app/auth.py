"""Authentication: sign-in with Scouter ID + shared team password.

The team password is the same for everyone (HazeRain!).  The Scouter ID
identifies the user and ``admin`` is privileged.  Accounts are auto-provisioned
on first successful sign-in (just like the old PurpleScout betting accounts).

Tokens are stateless HMAC-signed blobs — no extra dependency required.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from sqlmodel import Session

from .config import settings
from .database import get_session
from .models import Scouter


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
    except Exception:
        return None
    if body.get("exp", 0) < time.time():
        return None
    return body


def normalize_id(scout_id: str) -> str:
    return scout_id.strip()


def verify_team_password(password: str) -> bool:
    return password == settings.TEAM_PASSWORD


def get_or_create_scouter(session: Session, scout_id: str) -> Scouter:
    scout_id = normalize_id(scout_id)
    scouter = session.get(Scouter, scout_id)
    if scouter is None:
        scouter = Scouter(
            scout_id=scout_id,
            display_name=scout_id,
            is_admin=(scout_id.lower() == settings.ADMIN_ID.lower()),
            bucks=settings.STARTING_BUCKS,
        )
        session.add(scouter)
        session.commit()
        session.refresh(scouter)
    return scouter


# --- FastAPI dependencies --------------------------------------------------- #
def current_scouter(
    authorization: str = Header(default=""),
    session: Session = Depends(get_session),
) -> Scouter:
    token = authorization.removeprefix("Bearer ").strip()
    body = decode_token(token)
    if not body:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not signed in",
        )
    scouter = session.get(Scouter, body["sub"])
    if scouter is None:
        raise HTTPException(status_code=401, detail="Unknown scouter")
    return scouter


def require_admin(scouter: Scouter = Depends(current_scouter)) -> Scouter:
    if not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    return scouter
