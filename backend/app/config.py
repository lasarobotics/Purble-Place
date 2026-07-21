"""
HazeHub configuration.

Detects whether we are running locally or on Azure and configures the
database / realtime layer accordingly.  Everything has a sane local default
so the app "just works" with zero setup, but switches to the production
services automatically when the relevant Azure environment variables appear.
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

# Repo paths -----------------------------------------------------------------
APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent

# Vercel's filesystem is read-only except /tmp; keep the SQLite fallback there
# (per-instance scratch only — production must set DATABASE_URL to Postgres).
IS_VERCEL = os.environ.get("VERCEL") == "1"
DATA_DIR = Path("/tmp/data") if IS_VERCEL else BACKEND_DIR / "data"
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


def _on_azure() -> bool:
    """True when running inside an Azure-managed runtime."""
    return any(
        os.getenv(k)
        for k in (
            "WEBSITE_SITE_NAME",        # App Service
            "CONTAINER_APP_NAME",       # Container Apps
            "AZURE_FUNCTIONS_ENVIRONMENT",
            "HAZEHUB_FORCE_AZURE",      # manual override for testing
        )
    )


def _database_url() -> str:
    """Pick a database URL.

    Priority:
      1. Explicit DATABASE_URL (Azure Database for PostgreSQL, etc.)
      2. Local SQLite file (no setup required)
    """
    url = os.getenv("DATABASE_URL", "").strip()
    if url:
        # SQLAlchemy expects postgresql+psycopg, normalise common variants.
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+psycopg://", 1)
        elif url.startswith("postgresql://") and "+psycopg" not in url:
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        return url
    return f"sqlite:///{(DATA_DIR / 'hazehub.db').as_posix()}"


class Settings:
    """Runtime settings, resolved once at import."""

    # Identity / branding
    APP_NAME: str = "HazeHub"
    BRAND_COLOR: str = "#663399"  # Purple Haze
    SEASON: int = int(os.getenv("HAZEHUB_SEASON", "2026"))

    # Home teams: FRC 418 Purple Haze / FRC 436 Purple Rain
    HOME_TEAMS: list[int] = [
        int(t) for t in os.getenv("HAZEHUB_HOME_TEAMS", "418,436").split(",") if t.strip().isdigit()
    ]

    # Auth
    TEAM_PASSWORD: str = os.getenv("HAZEHUB_TEAM_PASSWORD", "HazeRain!")
    ADMIN_ID: str = os.getenv("HAZEHUB_ADMIN_ID", "admin")
    SECRET_KEY: str = os.getenv("HAZEHUB_SECRET", "purple-haze-dev-secret-change-me")
    TOKEN_TTL_HOURS: int = 24 * 14

    # Economy
    STARTING_BUCKS: int = 100

    # External APIs (keys provided by the team)
    TBA_KEY: str = os.getenv(
        "TBA_AUTH_KEY",
        "rZxJQVjP40eTtskoUbT3OWTKEnKNxk8McjB9QqRdU8mT78o8EN3OuzuMppJTADtV",
    )
    TBA_BASE: str = "https://www.thebluealliance.com/api/v3"
    STATBOTICS_BASE: str = "https://api.statbotics.io/v3"
    EXTERNAL_TTL_SECONDS: int = int(os.getenv("HAZEHUB_CACHE_TTL", "900"))

    # Environment
    IS_AZURE: bool = _on_azure()
    IS_VERCEL: bool = IS_VERCEL
    DATABASE_URL: str = _database_url()

    # Direct-to-cloud design: this API *is* the shared source of truth.
    # Devices keep their own IndexedDB queues and sync straight here over
    # HTTPS with UUID + payload-hash idempotency. There is no MegaScout middle
    # tier, no outbox, and no sync worker.

    # Optional UniFi/gateway stats endpoint for the admin network panel. When
    # unset, the panel reports network fields as "unavailable" rather than
    # faking numbers (the physical gateway API isn't reachable in dev).
    GATEWAY_STATS_URL: str = os.getenv("HAZEHUB_GATEWAY_STATS_URL", "").strip()

    @property
    def DATABASE_CONFIGURED(self) -> bool:
        """True when a real (non-SQLite-fallback) database URL is set."""
        return not self.DATABASE_URL.startswith("sqlite")

    # CORS — local dev front-ends + anything you configure for cloud hosts
    @property
    def cors_origins(self) -> list[str]:
        extra = os.getenv("HAZEHUB_CORS", "")
        origins = [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
        ]
        if extra:
            origins.extend(o.strip() for o in extra.split(",") if o.strip())
        # Same-origin on Vercel services needs no CORS; the wildcard keeps any
        # split deployment working when nothing custom is configured.
        if (self.IS_AZURE or self.IS_VERCEL) and not extra:
            origins.append("*")
        return origins


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
