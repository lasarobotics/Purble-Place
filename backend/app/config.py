"""
HazeHub configuration.

Everything has a sane local default so the app "just works" with no setup,
and switches to the Firebase services automatically once the relevant
environment variables appear.

Datastore selection (see ``cache.Store.start``):

* ``FIRESTORE_EMULATOR_HOST`` set  -> the local Firestore emulator.
* ``FIREBASE_PROJECT_ID`` set (or running on Cloud Run, where the project is
  discovered automatically) -> Cloud Firestore.
* neither -> a JSON file under ``backend/data/`` so a fresh clone runs offline.
"""
from __future__ import annotations

import os
import json
from functools import lru_cache
from pathlib import Path


# Repo paths -----------------------------------------------------------------
APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent

# Cloud Run's filesystem is read-only except /tmp. Nothing durable is written
# there: Firestore holds the data: but the dev fallback store needs a home.
IS_CLOUD_RUN = bool(os.environ.get("K_SERVICE"))
DATA_DIR = Path("/tmp/data") if IS_CLOUD_RUN else BACKEND_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_dotenv() -> None:
    """Minimal .env loader (no dependency). Only sets keys not already set."""
    env_file = BACKEND_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()


def _firebase_project() -> str:
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


def _environment() -> str:
    if os.getenv("FIRESTORE_EMULATOR_HOST", "").strip():
        return "emulator"
    if IS_CLOUD_RUN:
        return "cloud-run"
    if _firebase_project():
        return "firebase"
    return "local"


class Settings:
    """Runtime settings, resolved once at import."""

    # Identity / branding
    APP_NAME: str = "Purble Place"
    BRAND_COLOR: str = "#663399"  # Purple Haze
    # A fallback only. The real season lives in the datastore (app/seasons.py);
    # this is what a brand new install bootstraps with before one exists.
    SEASON: int = int(os.getenv("HAZEHUB_SEASON", "2026"))

    # Home teams: FRC 418 Purple Haze / FRC 436 Purple Rain
    HOME_TEAMS: list[int] = [
        int(t) for t in os.getenv("HAZEHUB_HOME_TEAMS", "418,436").split(",") if t.strip().isdigit()
    ]

    # Auth
    TEAM_PASSWORD: str = os.getenv("HAZEHUB_TEAM_PASSWORD", "HazeRain!")
    SECRET_KEY: str = os.getenv("HAZEHUB_SECRET", "purple-haze-dev-secret-change-me")
    TOKEN_TTL_HOURS: int = 24 * 14

    # Spreadsheet roster is authoritative; legacy environment overrides cannot
    # restore deleted accounts or introduce additional administrators.
    ACCOUNTS: dict[str, str] = {"Admin": "admin", **{
        scout_id: "scouter" for scout_id in json.loads(
            (APP_DIR / "account_roster.json").read_text(encoding="utf-8")
        )
    }}
    ACCOUNT_ALIASES: dict[str, str] = {}

    # Economy
    STARTING_BUCKS: int = 100

    # External APIs (keys provided by the team)
    TBA_KEY: str = os.getenv("TBA_AUTH_KEY", "").strip()
    TBA_BASE: str = "https://www.thebluealliance.com/api/v3"
    STATBOTICS_BASE: str = "https://api.statbotics.io/v3"
    MATCH13_KEY: str = os.getenv("MATCH13_API_KEY", "").strip()
    MATCH13_BASE: str = os.getenv("MATCH13_API_BASE", "https://actions.match13.com").rstrip("/")
    EXTERNAL_TTL_SECONDS: int = int(os.getenv("HAZEHUB_CACHE_TTL", "900"))

    # Environment / datastore
    DATA_DIR: Path = DATA_DIR
    IS_CLOUD_RUN: bool = IS_CLOUD_RUN
    FIREBASE_PROJECT_ID: str = _firebase_project()
    ENVIRONMENT: str = _environment()

    # Firebase Hosting site (used to build the default CORS allowlist).
    FIREBASE_SITE: str = os.getenv("FIREBASE_SITE", "").strip() or _firebase_project()

    # This API is the shared source of truth. Devices keep their own IndexedDB
    # queues and sync straight here over HTTPS with UUID + payload-hash
    # idempotency; the submission UUID is the Firestore document ID, so a
    # replayed queue can never duplicate a record.

    # Optional UniFi/gateway stats endpoint for the admin network panel. When
    # unset, the panel reports network fields as "unavailable" rather than
    # faking numbers (the physical gateway API isn't reachable in dev).
    GATEWAY_STATS_URL: str = os.getenv("HAZEHUB_GATEWAY_STATS_URL", "").strip()

    @property
    def DATABASE_CONFIGURED(self) -> bool:
        """True when a real Firestore database (not the dev file) is in use."""
        return self.ENVIRONMENT in ("firebase", "cloud-run", "emulator")

    # CORS: local dev front-ends plus the project's Firebase Hosting domains.
    #
    # In the normal deployment this is unused: the same process serves the web
    # app and the API, so every request is same-origin. It matters for
    # `next dev` against a separately-run backend, and for a split deployment.
    @property
    def cors_origins(self) -> list[str]:
        extra = os.getenv("HAZEHUB_CORS", "")
        origins = [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
            "http://localhost:5000",   # firebase emulators:start --only hosting
            "http://localhost:8000",
        ]
        if self.FIREBASE_SITE:
            origins += [
                f"https://{self.FIREBASE_SITE}.web.app",
                f"https://{self.FIREBASE_SITE}.firebaseapp.com",
            ]
        if extra:
            origins.extend(o.strip() for o in extra.split(",") if o.strip())
        return origins

    @property
    def cors_origin_regex(self) -> str:
        """Allow any device on a private LAN.

        At an event the tablets reach the host laptop by its LAN address,
        which nobody knows in advance. This matches only RFC1918 / link-local
        addresses and .local names, so it cannot open the API to the internet.
        """
        return (
            r"^https?://("
            r"localhost|127\.0\.0\.1|\[::1\]|"
            r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
            r"192\.168\.\d{1,3}\.\d{1,3}|"
            r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|"
            r"169\.254\.\d{1,3}\.\d{1,3}|"
            r"[A-Za-z0-9-]+\.local"
            r")(:\d+)?$"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
