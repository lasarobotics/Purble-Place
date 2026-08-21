"""Cloud Firestore client, operation accounting, and the daily quota guard.

Credentials are resolved in the order that makes each environment work with
no configuration of its own:

1. ``FIRESTORE_EMULATOR_HOST``: local development against
   ``firebase emulators:start``. No credentials needed at all.
2. ``FIREBASE_SERVICE_ACCOUNT``: either a path to a service-account JSON file
   or the JSON itself (handy for a single secret in Cloud Run / CI).
3. ``GOOGLE_APPLICATION_CREDENTIALS``: the standard Google variable.
4. Application Default Credentials: what Cloud Run uses; the service's own
   service account is picked up automatically with nothing to configure.

Why the counters exist
----------------------
Firestore's always-free daily allowance is 50,000 document reads, 20,000
writes and 20,000 deletes. Those are *document* operations, not requests, and
the failure mode is silent until the day's quota is gone: so every Firestore
call in HazeHub goes through :func:`count` and is visible on the admin System
Health panel and at ``GET /api/admin/firestore-usage``.

:class:`QuotaGuard` turns that accounting into a safety net. As the day's
budget is consumed it sheds optional work (presence heartbeats, network
snapshots, external-cache persistence) while never blocking a scouting
submission: losing a scout's match data to save a write would be exactly the
wrong trade.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

log = logging.getLogger("hazehub.firestore")

# --------------------------------------------------------------------------- #
# Quota accounting                                                             #
# --------------------------------------------------------------------------- #
#: Firestore's always-free daily allowances (per database).
FREE_TIER = {"read": 50_000, "write": 20_000, "delete": 20_000}


def _pacific_now() -> datetime:
    """Now, in the timezone Firestore's daily quotas reset in (US Pacific).

    Falls back to a fixed UTC-8 offset if the platform has no tz database
    (bare Windows installs without the ``tzdata`` package).
    """
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:  # noqa: BLE001: no tzdb; the approximation is fine here
        return datetime.now(timezone(timedelta(hours=-8)))


def _quota_day() -> str:
    return _pacific_now().strftime("%Y-%m-%d")


@dataclass
class QuotaGuard:
    """Counts document operations against the daily free-tier allowance."""

    #: Budgets default to ~90% of the free tier, leaving headroom for a
    #: restart's cold-start reads on a busy day.
    read_budget: int = int(os.getenv("HAZEHUB_READ_BUDGET", "45000"))
    write_budget: int = int(os.getenv("HAZEHUB_WRITE_BUDGET", "18000"))
    delete_budget: int = int(os.getenv("HAZEHUB_DELETE_BUDGET", "18000"))

    day: str = field(default_factory=_quota_day)
    counts: dict[str, int] = field(
        default_factory=lambda: {"read": 0, "write": 0, "delete": 0}
    )
    #: Ops refused because the budget for optional work was exhausted.
    shed: dict[str, int] = field(
        default_factory=lambda: {"read": 0, "write": 0, "delete": 0}
    )
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def _roll(self) -> None:
        today = _quota_day()
        if today != self.day:
            self.day = today
            self.counts = {"read": 0, "write": 0, "delete": 0}
            self.shed = {"read": 0, "write": 0, "delete": 0}

    def budget(self, kind: str) -> int:
        return {
            "read": self.read_budget,
            "write": self.write_budget,
            "delete": self.delete_budget,
        }[kind]

    def count(self, kind: str, n: int = 1) -> None:
        if n <= 0:
            return
        with self._lock:
            self._roll()
            self.counts[kind] = self.counts.get(kind, 0) + n

    def allow(self, kind: str, n: int = 1, essential: bool = False) -> bool:
        """May ``n`` operations of ``kind`` proceed?

        Essential work (scouting submissions, bets, picklists, sign-in) is
        always allowed: the guard is there to protect them by shedding
        everything else first.
        """
        if essential:
            return True
        with self._lock:
            self._roll()
            if self.counts.get(kind, 0) + n <= self.budget(kind):
                return True
            self.shed[kind] = self.shed.get(kind, 0) + n
            return False

    def pressure(self, kind: str) -> float:
        """0.0-1.0+: how much of the day's budget for ``kind`` is spent."""
        with self._lock:
            self._roll()
            return round(self.counts.get(kind, 0) / max(1, self.budget(kind)), 4)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            self._roll()
            uptime_h = max(
                0.05,
                (datetime.now(timezone.utc) - self.started_at).total_seconds() / 3600,
            )
            out: dict[str, Any] = {
                "quota_day": self.day,
                "resets_at": "00:00 America/Los_Angeles",
                "process_uptime_hours": round(uptime_h, 2),
                "operations": {},
            }
            for kind in ("read", "write", "delete"):
                used = self.counts.get(kind, 0)
                out["operations"][kind] = {
                    "used": used,
                    "budget": self.budget(kind),
                    "free_tier_limit": FREE_TIER[kind],
                    "pct_of_budget": round(used / max(1, self.budget(kind)) * 100, 1),
                    "projected_12h": int(used / uptime_h * 12),
                    "shed": self.shed.get(kind, 0),
                }
            return out


guard = QuotaGuard()


def count(kind: str, n: int = 1) -> None:
    """Record ``n`` Firestore document operations of ``kind``."""
    guard.count(kind, n)


# --------------------------------------------------------------------------- #
# Client                                                                       #
# --------------------------------------------------------------------------- #
_client: Any = None
_client_lock = threading.Lock()
_init_error: str = ""


def _emulator_credential():
    """A credential that skips OAuth entirely, for the local emulator.

    The emulator accepts any project and never checks a token, but the Admin
    SDK still resolves Application Default Credentials before building a
    client: which fails on a laptop with no gcloud login. Handing it
    anonymous credentials is what makes ``firebase emulators:start`` work with
    zero setup.
    """
    from firebase_admin import credentials
    from google.auth.credentials import AnonymousCredentials

    class _Anonymous(credentials.Base):
        def get_credential(self):
            return AnonymousCredentials()

    return _Anonymous()


def _credentials():
    """Build a ``firebase_admin.credentials`` object, or None for ADC."""
    from firebase_admin import credentials

    raw = os.getenv("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if raw:
        # Two accepted forms: the JSON itself (how Render and other hosts
        # without a filesystem supply it) or a path to the downloaded file.
        if raw.lstrip().startswith("{"):
            try:
                return credentials.Certificate(json.loads(raw))
            except json.JSONDecodeError as exc:
                raise ValueError(
                    "FIREBASE_SERVICE_ACCOUNT looks like JSON but did not parse "
                    f"({exc}). If you pasted the key into a web form, flatten it "
                    "to one line first: deploy/render-key.ps1 does this."
                ) from exc
        if not os.path.exists(raw):
            # Without this, firebase_admin raises a bare FileNotFoundError
            # naming the value: which is baffling when someone has pasted the
            # wrong secret into the variable.
            hint = f"{raw[:12]}..." if len(raw) > 12 else raw
            raise ValueError(
                "FIREBASE_SERVICE_ACCOUNT is neither valid JSON nor a path to an "
                f"existing file (got {hint!r}). Set it to the full contents of the "
                "service-account key, or to the path of the downloaded .json file."
            )
        return credentials.Certificate(raw)
    path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if path and os.path.exists(path):
        return credentials.Certificate(path)
    return None  # Application Default Credentials


def project_id() -> str:
    for key in (
        "FIREBASE_PROJECT_ID",
        "GOOGLE_CLOUD_PROJECT",
        "GCLOUD_PROJECT",
        "GCP_PROJECT",
    ):
        value = os.getenv(key, "").strip()
        if value:
            return value
    return ""


def using_emulator() -> bool:
    return bool(os.getenv("FIRESTORE_EMULATOR_HOST", "").strip())


def get_client():
    """The process-wide Firestore client (created once, thread-safe)."""
    global _client, _init_error
    if _client is not None:
        return _client
    with _client_lock:
        if _client is not None:
            return _client
        import firebase_admin
        from firebase_admin import firestore

        pid = project_id()
        if using_emulator() and not pid:
            # The emulator accepts any project ID; give it a stable one so
            # data survives across restarts of the dev server.
            pid = "hazehub-local"
            os.environ["GOOGLE_CLOUD_PROJECT"] = pid

        try:
            if not firebase_admin._apps:
                options = {"projectId": pid} if pid else None
                cred = _emulator_credential() if using_emulator() else _credentials()
                firebase_admin.initialize_app(cred, options)
            _client = firestore.client()
            _init_error = ""
        except Exception as exc:  # noqa: BLE001
            _init_error = f"{type(exc).__name__}: {exc}"
            raise
        return _client


def try_get_client():
    """``get_client()`` but returns None instead of raising.

    Used on the boot path and by ``/api/health`` so a misconfigured deployment
    still starts and reports a clear diagnostic instead of crash-looping.
    """
    try:
        return get_client()
    except Exception:  # noqa: BLE001
        return None


def init_error() -> str:
    return _init_error


#: The connectivity probe is a network round trip, and /api/health is hit by
#: the host's uptime checker every few seconds: thousands of times a day.
#: Caching the result keeps that from being a constant background cost on a
#: small instance, while still surfacing an outage within half a minute.
_PROBE_TTL_S = 30.0
_probe: tuple[float, bool, str] = (0.0, False, "")
_probe_lock = threading.Lock()


def _probe_connection(client) -> tuple[bool, str]:  # noqa: ANN001
    global _probe
    now = time.monotonic()
    with _probe_lock:
        checked_at, ok, err = _probe
        if now - checked_at < _PROBE_TTL_S:
            return ok, err
    try:
        # Cheapest possible round trip: list at most one collection. Listing
        # collections is not billed as a document read.
        next(iter(client.collections()), None)
        result = (True, "")
    except Exception as exc:  # noqa: BLE001
        result = (False, f"{type(exc).__name__}: {exc}")
    with _probe_lock:
        _probe = (now, result[0], result[1])
    return result


def status() -> dict[str, Any]:
    """Connectivity + configuration summary for /api/health and System Health."""
    pid = project_id()
    client = try_get_client()
    reachable = client is not None
    error = _init_error
    if reachable:
        reachable, probe_error = _probe_connection(client)
        if probe_error:
            error = probe_error
    out: dict[str, Any] = {
        "engine": "firestore",
        "project_id": pid,
        "emulator": using_emulator(),
        "configured": bool(pid) or using_emulator(),
        "reachable": reachable,
    }
    if error:
        out["error"] = error
    if not out["configured"]:
        out["warning"] = (
            "No Firebase project configured: set FIREBASE_PROJECT_ID (and "
            "FIREBASE_SERVICE_ACCOUNT outside Google Cloud). See instructions.txt."
        )
    return out


def collection(name: str):
    return get_client().collection(name)


def document(collection_name: str, doc_id: str):
    return get_client().collection(collection_name).document(doc_id)


def server_timestamp():
    from firebase_admin import firestore

    return firestore.SERVER_TIMESTAMP


def delete_field():
    from firebase_admin import firestore

    return firestore.DELETE_FIELD


def field_filter(path: str, op: str, value: Any):
    """``FieldFilter``: the non-deprecated form of ``.where()``."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    return FieldFilter(path, op, value)
