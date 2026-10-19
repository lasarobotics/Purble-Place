"""Closed-roster authentication with personal password hashes and signed sessions."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, Header, HTTPException, Request, status

from . import repo, schema
from .config import settings
from .models import ROLE_ADMIN, ROLE_SCOUTER, Scouter

log = logging.getLogger("hazehub.auth")


def _auth_failure(reason: str) -> None:
    # Fixed reason codes only: never log tokens, passwords or account IDs.
    log.info("authentication_rejected reason=%s", reason)


def next_s_number() -> int:
    """Sequential scout number (unique across the scouters collection)."""
    return repo.next_s_number()


def _sign(data: bytes) -> str:
    sig = hmac.new(settings.SECRET_KEY.encode(), data, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).decode().rstrip("=")


def create_token(scout_id: str, is_admin: bool) -> str:
    account = repo.scouter(scout_id)
    body = {
        "sub": scout_id,
        "admin": is_admin,
        "auth_version": 2,
        "credential_revision": credential_revision(account) if account else "",
        "exp": int(time.time()) + settings.TOKEN_TTL_HOURS * 3600,
    }
    raw = base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")
    return f"{raw}.{_sign(raw.encode())}"


def credential_revision(account: Scouter) -> str:
    raw = account.password_hash or ""
    if account.auth_revision:
        raw += f"|{account.auth_revision}"
    return _sign(raw.encode())


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
    if body.get("auth_version") != 2 or body.get("exp", 0) < time.time():
        return None
    return body


def normalize_id(scout_id: str) -> str:
    """Trim and validate a scouter ID.

    The ID becomes a Firestore document ID, so it has to satisfy Firestore's
    rules (no ``/``, not ``.``/``..``, not ``__*__``, ≤1500 bytes): checked
    here so a bad login fails with a 400 rather than an opaque write error.
    """
    try:
        return schema.safe_doc_id(scout_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid Scouter ID: {exc}") from exc


def verify_team_password(password: str) -> bool:
    return hmac.compare_digest((password or "").encode(), settings.TEAM_PASSWORD.encode())


def verify_login_password(scout_id: str, password: str) -> bool:
    canonical = canonical_account_id(scout_id)
    account = repo.scouter(canonical) if canonical else None
    if not account or not account.active or account.deleted:
        return False
    if account.password_hash:
        return verify_password(password, account.password_hash)
    # Preserve the existing admin credential; roster members must enroll.
    return canonical == "Admin" and verify_team_password(password)


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f"scrypt${salt}${digest}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, salt, expected = encoded.split("$")
        if algorithm != "scrypt" or len(password) > 128:
            return False
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        return hmac.compare_digest(digest, expected)
    except (ValueError, TypeError):
        return False


def canonical_account_id(scout_id: str) -> Optional[str]:
    """Map whatever was typed onto a roster ID, or ``None`` if it is not one.

    Matching is case-insensitive because people type "admin" and "Admin"
    interchangeably on a phone keyboard, and the roster's own spelling is what
    gets stored, so there is exactly one document per account no matter how it
    was entered.
    """
    key = (scout_id or "").strip()
    if not key:
        return None
    lowered = key.lower()
    for account in repo.scouters():
        if account.scout_id.lower() == lowered:
            return account.scout_id
    for canonical in settings.ACCOUNTS:
        if canonical.lower() == lowered:
            return canonical
    aliased = settings.ACCOUNT_ALIASES.get(lowered)
    if aliased and aliased in settings.ACCOUNTS:
        return aliased
    return None


def role_for_new_account(scout_id: str) -> str:
    """The role an account on the roster gets."""
    canonical = canonical_account_id(scout_id) or scout_id
    return settings.ACCOUNTS.get(canonical, ROLE_SCOUTER)


#: Shown when someone types an ID that is not on the roster. It deliberately
#: does not list the valid IDs -- the team knows them, and the shared password
#: means anyone who could read this list could use it.
UNKNOWN_ACCOUNT_MESSAGE = (
    "That Scouter ID does not exist. HazeHub only has the accounts the team "
    "set up, and new ones cannot be created by signing in. Check the "
    "spelling, or ask an admin which account to use."
)


def get_account(scout_id: str) -> Scouter:
    """Look up a roster account and stamp it as seen.

    Signing in never creates an account any more. The roster lives in
    configuration and is written to the ``scouters`` collection at startup, so
    an unknown ID is a mistake to report rather than a person to enrol.
    """
    canonical = canonical_account_id(scout_id)
    if canonical is None:
        raise HTTPException(status_code=403, detail=UNKNOWN_ACCOUNT_MESSAGE)
    canonical = normalize_id(canonical)
    scouter = repo.scouter(canonical)
    if scouter is None:
        # On the roster but not in the datastore yet: seeding runs at startup,
        # so this only happens on a database that was wiped mid-run.
        scouter = Scouter(
            scout_id=canonical,
            s_number=next_s_number(),
            display_name=canonical,
            role=role_for_new_account(canonical),
            bucks=settings.STARTING_BUCKS,
        )
    scouter.last_seen = datetime.now(timezone.utc)
    repo.save_scouter(scouter)
    repo.touch_presence(scouter.scout_id)
    return scouter


#: Kept under the old name for callers that predate the closed roster.
get_or_create_scouter = get_account


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
    "/api/pages",
)

#: Read-only paths that need a method check as well as a prefix. Picklist
#: justifications can reference a match ("@42"), and reading that reference is
#: the whole point of the meeting screen: but the same prefix is how scouting
#: gets submitted, so only the GETs are let through.
#: ``/api/pit`` is here rather than above because the team detail popup
#: reads a robot's pit report, but a projector account must not be able to
#: submit one.
PICKLIST_ALLOWED_READS = ("/api/scout/match", "/api/scout/team", "/api/pit", "/api/admin/data-analysis", "/api/admin/analysis")


def _picklist_account_may_reach(path: str, method: str = "GET") -> bool:
    if any(path.startswith(prefix) for prefix in PICKLIST_ALLOWED_PREFIXES):
        return True
    return method.upper() in ("GET", "HEAD") and any(
        path.startswith(prefix) for prefix in PICKLIST_ALLOWED_READS
    )


# --- FastAPI dependencies --------------------------------------------------- #
def current_scouter(
    request: Request, authorization: str = Header(default="")
) -> Scouter:
    token = authorization.removeprefix("Bearer ").strip()
    # Cookie restoration is restricted to this read-only endpoint. Mutations
    # still require an explicit bearer header, avoiding cookie-based CSRF.
    if not token and request.method == "GET" and request.url.path == "/api/auth/me":
        token = request.cookies.get("hazehub_session", "")
    body = decode_token(token)
    if not body:
        _auth_failure("missing_token" if not token else "invalid_or_expired_token")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not signed in",
        )
    scouter = repo.scouter(body["sub"])
    if scouter is None and not repo.store.ready and (repo.store.backend is not None or repo.store.error):
        _auth_failure("account_cache_unavailable")
        raise HTTPException(status_code=503, detail="Accounts are temporarily unavailable. Please retry.")
    if scouter is None or not scouter.active or scouter.deleted or canonical_account_id(scouter.scout_id) != scouter.scout_id:
        _auth_failure("account_removed")
        raise HTTPException(status_code=401, detail="Unknown scouter")
    if scouter.scout_id != "Admin" and not scouter.password_hash:
        _auth_failure("password_setup_required")
        raise HTTPException(status_code=401, detail="Password setup required")
    if not hmac.compare_digest(body.get("credential_revision", ""), credential_revision(scouter)):
        _auth_failure("credential_revision_changed")
        raise HTTPException(status_code=401, detail="Credentials changed. Sign in again.")
    if scouter.scout_id == "Admin":
        scouter.role = ROLE_ADMIN
    if scouter.picklist_only and not _picklist_account_may_reach(
        request.url.path, request.method
    ):
        raise HTTPException(
            status_code=403,
            detail="This is a picklist meeting account. It can only view teams "
            "and edit picklists. Sign in with your own account for anything else.",
        )
    # Presence is tracked in memory and persisted at most hourly: see
    # repo.touch_presence. Doing it on every request costs nothing.
    repo.touch_presence(scouter.scout_id)
    return scouter


def require_admin(scouter: Scouter = Depends(current_scouter)) -> Scouter:
    """Only the designated Admin can use event and system controls."""
    if scouter.scout_id != "Admin" or scouter.role != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Admin only")
    return scouter


def require_full_admin(scouter: Scouter = Depends(current_scouter)) -> Scouter:
    """Admin only. Used for the few actions strategy should not perform,
    such as changing someone else's role."""
    if scouter.scout_id != "Admin" or scouter.role != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Admin only")
    return scouter
