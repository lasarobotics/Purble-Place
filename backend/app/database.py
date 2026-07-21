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
    _apply_micro_migrations()


# Columns added after the first release: (table, column, DDL type).
# create_all never ALTERs existing tables, so this closes the gap for local
# SQLite files created before the column existed. Works on Postgres too.
# (Empty after the 2027-schema rebuild — tables were renamed, so old dev DBs
# should be regenerated with `python -m app.demo_data`.)
_NEW_COLUMNS: list[tuple[str, str, str]] = [
    # Direct-to-cloud submission envelope, added to an existing table.
    ("match_scouting", "submission_id", "VARCHAR"),
    ("match_scouting", "client_ts", "TIMESTAMP"),
    ("match_scouting", "azure_received_at", "TIMESTAMP"),
    ("match_scouting", "payload_hash", "VARCHAR"),
    ("match_scouting", "schema_version", "INTEGER"),
    ("match_scouting", "server_version", "INTEGER"),
    ("match_scouting", "supersedes_submission_id", "VARCHAR"),
]


def _apply_micro_migrations() -> None:
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    with engine.begin() as conn:
        for table, column, ddl_type in _NEW_COLUMNS:
            if table not in inspector.get_table_names():
                continue
            existing = {c["name"] for c in inspector.get_columns(table)}
            if column not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"))


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
