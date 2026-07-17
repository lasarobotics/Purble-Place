"""MongoDB connection lifecycle and idempotent schema initialization."""

from __future__ import annotations

from datetime import UTC, datetime
from threading import Lock
from typing import Any, Iterator

import certifi
from pymongo import MongoClient
from pymongo.database import Database

from .config import settings
from .schema import COLLECTION_INDEXES, COLLECTION_SCHEMAS, SCHEMA_VERSION


_client: MongoClient | None = None
_client_lock = Lock()
_schema_checked = False


def _client_kwargs() -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "appname": "HazeHub",
        "tz_aware": True,
        "serverSelectionTimeoutMS": settings.mongodb_timeout_ms,
        "connectTimeoutMS": settings.mongodb_timeout_ms,
    }
    # Atlas (mongodb+srv:// or tls=true) on serverless runtimes: point TLS at
    # certifi's CA bundle — the Vercel Python image doesn't always ship one
    # that validates Atlas certificates.
    uri = settings.mongodb_uri.lower()
    if uri.startswith("mongodb+srv://") or "tls=true" in uri or "ssl=true" in uri:
        kwargs["tlsCAFile"] = certifi.where()
    return kwargs


def get_client() -> MongoClient:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = MongoClient(settings.mongodb_uri, **_client_kwargs())
    return _client


def get_database() -> Database:
    """Return the configured database (also suitable as a FastAPI dependency)."""
    return get_client()[settings.mongodb_database]


def database_dependency() -> Iterator[Database]:
    """FastAPI-compatible dependency without owning the process-wide client."""
    yield get_database()


def init_database() -> Database:
    """Create/update collection validators and indexes, then return the DB.

    This operation is idempotent and is safe to run on every application
    startup. It intentionally fails fast when MongoDB is unreachable or the
    deployment user lacks schema-management permissions.
    """
    client = get_client()
    client.admin.command("ping")
    database = get_database()
    existing = set(database.list_collection_names())

    for collection_name, json_schema in COLLECTION_SCHEMAS.items():
        validator = {"$jsonSchema": json_schema}
        if collection_name not in existing:
            database.create_collection(
                collection_name,
                validator=validator,
                validationLevel="strict",
                validationAction="error",
            )
        else:
            database.command(
                {
                    "collMod": collection_name,
                    "validator": validator,
                    "validationLevel": "strict",
                    "validationAction": "error",
                }
            )

        indexes = COLLECTION_INDEXES.get(collection_name, [])
        if indexes:
            database[collection_name].create_indexes(indexes)

    database["schema_meta"].update_one(
        {"_id": "hazehub"},
        {
            "$set": {
                "version": SCHEMA_VERSION,
                "collections": sorted(COLLECTION_SCHEMAS),
                "applied_at": datetime.now(UTC),
            }
        },
        upsert=True,
    )
    return database


def ensure_schema() -> None:
    """Run ``init_database`` once per process, skipping when already current.

    Serverless deployments cold-start often; checking ``schema_meta`` first
    keeps warm-path startups down to a single indexed read instead of a full
    collMod/createIndexes sweep.
    """
    global _schema_checked
    if _schema_checked:
        return
    database = get_database()
    meta = database["schema_meta"].find_one({"_id": "hazehub"})
    if not meta or meta.get("version") != SCHEMA_VERSION:
        init_database()
    _schema_checked = True


def close_database() -> None:
    global _client, _schema_checked
    with _client_lock:
        if _client is not None:
            _client.close()
            _client = None
        _schema_checked = False


if __name__ == "__main__":
    initialized = init_database()
    print(
        f"Initialized MongoDB database {initialized.name!r} "
        f"at schema version {SCHEMA_VERSION}."
    )
    close_database()
