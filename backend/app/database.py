"""Database engine + session helpers (SQLModel / SQLAlchemy)."""
from __future__ import annotations

from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from .config import settings

_connect_args = {}
if settings.DATABASE_URL.startswith("sqlite"):
    # Needed so the SQLite connection works across FastAPI's threadpool.
    _connect_args = {"check_same_thread": False}

engine = create_engine(
    settings.DATABASE_URL,
    echo=False,
    connect_args=_connect_args,
    pool_pre_ping=not settings.DATABASE_URL.startswith("sqlite"),
)


def init_db() -> None:
    """Create tables. On Azure you would normally run Alembic migrations,
    but create_all keeps local dev frictionless and is idempotent."""
    # Import models so SQLModel.metadata is populated before create_all.
    from . import models  # noqa: F401

    SQLModel.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
