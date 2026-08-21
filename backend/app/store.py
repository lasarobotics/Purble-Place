"""Key/value app settings (``app_settings`` collection).

Kept as its own module because the settings are read on nearly every request
(``current_event`` resolves the default event): they live in the cache, so a
read here is a dict lookup, not a Firestore operation.
"""
from __future__ import annotations

from . import repo

DEFAULTS = repo.SETTING_DEFAULTS


def get_setting(key: str) -> str:
    return repo.setting(key)


def set_setting(key: str, value: str) -> None:
    repo.set_setting(key, value)


def all_settings() -> dict[str, str]:
    return repo.all_settings()
