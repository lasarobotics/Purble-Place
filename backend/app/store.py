"""Tiny key/value settings store on top of AppSetting."""
from __future__ import annotations

from sqlmodel import Session, select

from .models import AppSetting

DEFAULTS = {
    "current_event": "",
    "current_match": "0",       # match number currently on the field
    "betting_enabled": "1",
}


def get_setting(session: Session, key: str) -> str:
    row = session.get(AppSetting, key)
    if row is None:
        return DEFAULTS.get(key, "")
    return row.value


def set_setting(session: Session, key: str, value: str) -> None:
    row = session.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key, value=value)
    else:
        row.value = value
    session.add(row)
    session.commit()


def all_settings(session: Session) -> dict[str, str]:
    out = dict(DEFAULTS)
    for row in session.exec(select(AppSetting)).all():
        out[row.key] = row.value
    return out
