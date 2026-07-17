"""Environment-backed configuration: MongoDB connection + HazeHub app settings.

Merges the backend-dev database-layer settings (MongoDB) with the application
settings the API needs (auth, economy, external API keys). Everything has a
sane local default so `docker compose up -d && uvicorn app.main:app` just
works; production values come from environment variables (Vercel project
settings).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    """Load a small .env file without adding another runtime dependency."""
    env_file = BACKEND_DIR / ".env"
    if not env_file.exists():
        return

    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


_load_dotenv()


@dataclass(frozen=True, slots=True)
class Settings:
    # MongoDB
    mongodb_uri: str
    mongodb_database: str
    mongodb_timeout_ms: int

    # Identity / branding
    app_name: str = "HazeHub"
    brand_color: str = "#663399"
    season: int = 2026
    home_teams: tuple[int, ...] = (418, 436)

    # Auth
    team_password: str = "HazeRain!"
    admin_id: str = "admin"
    secret_key: str = "purple-haze-dev-secret-change-me"
    token_ttl_hours: int = 24 * 14

    # Economy
    starting_bucks: int = 100

    # External APIs
    tba_key: str = ""
    tba_base: str = "https://www.thebluealliance.com/api/v3"
    statbotics_base: str = "https://api.statbotics.io/v3"
    external_ttl_seconds: int = 900

    # Environment
    is_vercel: bool = False
    cors_extra: tuple[str, ...] = ()

    @property
    def cors_origins(self) -> list[str]:
        origins = [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
        ]
        origins.extend(self.cors_extra)
        # Same-origin deployments (Vercel services) don't need CORS, but a
        # wildcard keeps split deployments working when nothing is configured.
        if self.is_vercel and not self.cors_extra:
            origins.append("*")
        return origins

    @classmethod
    def from_environment(cls) -> "Settings":
        database_name = os.getenv("MONGODB_DATABASE", "hazehub").strip()
        if not database_name or any(char in database_name for char in '/\\.$"'):
            raise ValueError("MONGODB_DATABASE is not a valid MongoDB database name")

        timeout_ms = int(os.getenv("MONGODB_TIMEOUT_MS", "5000"))
        if timeout_ms < 100:
            raise ValueError("MONGODB_TIMEOUT_MS must be at least 100")

        home_teams = tuple(
            int(t)
            for t in os.getenv("HAZEHUB_HOME_TEAMS", "418,436").split(",")
            if t.strip().isdigit()
        )
        cors_extra = tuple(
            o.strip() for o in os.getenv("HAZEHUB_CORS", "").split(",") if o.strip()
        )

        return cls(
            mongodb_uri=os.getenv(
                "MONGODB_URI",
                "mongodb://hazehub:hazehub_dev_password@localhost:27017/"
                "?authSource=admin",
            ).strip(),
            mongodb_database=database_name,
            mongodb_timeout_ms=timeout_ms,
            season=int(os.getenv("HAZEHUB_SEASON", "2026")),
            home_teams=home_teams or (418, 436),
            team_password=os.getenv("HAZEHUB_TEAM_PASSWORD", "HazeRain!"),
            admin_id=os.getenv("HAZEHUB_ADMIN_ID", "admin"),
            secret_key=os.getenv("HAZEHUB_SECRET", "purple-haze-dev-secret-change-me"),
            starting_bucks=int(os.getenv("HAZEHUB_STARTING_BUCKS", "100")),
            tba_key=os.getenv(
                "TBA_AUTH_KEY",
                "rZxJQVjP40eTtskoUbT3OWTKEnKNxk8McjB9QqRdU8mT78o8EN3OuzuMppJTADtV",
            ),
            external_ttl_seconds=int(os.getenv("HAZEHUB_CACHE_TTL", "900")),
            is_vercel=os.environ.get("VERCEL") == "1",
            cors_extra=cors_extra,
        )


@lru_cache
def get_settings() -> Settings:
    return Settings.from_environment()


settings = get_settings()
