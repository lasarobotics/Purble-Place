"""Tiny key/value settings store on top of the app_settings collection."""

from __future__ import annotations

from datetime import UTC, datetime

from pymongo.database import Database

DEFAULTS = {
    "current_event": "",
    "current_match": "0",  # match number currently on the field
    "betting_enabled": "1",
}


def get_setting(db: Database, key: str) -> str:
    doc = db.app_settings.find_one({"_id": key})
    if doc is None:
        return DEFAULTS.get(key, "")
    return str(doc.get("value", ""))


def set_setting(db: Database, key: str, value: str) -> None:
    db.app_settings.replace_one(
        {"_id": key},
        {"_id": key, "value": value, "updated_at": datetime.now(UTC)},
        upsert=True,
    )


def all_settings(db: Database) -> dict[str, str]:
    out = dict(DEFAULTS)
    for doc in db.app_settings.find({}):
        out[str(doc["_id"])] = str(doc.get("value", ""))
    return out
