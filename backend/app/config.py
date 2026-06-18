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
DATA_DIR = BACKEND_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)


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
    DATABASE_URL: str = _database_url()

    # CORS — local dev front-ends + anything you configure for Azure SWA
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
        # Allow all when nothing custom configured on Azure (SWA domains vary)
        if self.IS_AZURE and not extra:
            origins.append("*")
        return origins


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
