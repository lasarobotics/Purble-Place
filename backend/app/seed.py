"""Seed the starter accounts.

Runs on every boot but writes nothing when the documents already exist, so a
warm start costs zero Firestore operations.

The accounts created here exist so a fresh install is usable immediately and
so each role can be tried out. Which IDs map to which role is configurable
(HAZEHUB_ADMIN_IDS / HAZEHUB_STRATEGY_IDS / HAZEHUB_PICKLIST_IDS); an admin
can change any account's role later from the dashboard.
"""
from __future__ import annotations

from . import repo
from .auth import role_for_new_account
from .config import settings
from .models import ROLE_PICKLIST, ROLE_STRATEGY, Scouter

#: Demo scouters so every screen has data on a fresh install.
DEMO_IDS = ["1", "2", "3"]


def _label(scout_id: str, role: str) -> str:
    if scout_id == settings.ADMIN_ID:
        return "Administrator"
    if role == ROLE_STRATEGY:
        return "Strategy"
    if role == ROLE_PICKLIST:
        return "Picklist Meeting"
    return f"Scout {scout_id}"


def seed() -> None:
    new: list[Scouter] = []
    next_number = repo.next_s_number()

    starters = [settings.ADMIN_ID]
    starters += [i for i in settings.STRATEGY_IDS if i not in starters]
    starters += [i for i in settings.PICKLIST_IDS if i not in starters]
    starters += [i for i in DEMO_IDS if i not in starters]

    for scout_id in starters:
        if repo.scouter(scout_id) is not None:
            continue
        role = role_for_new_account(scout_id)
        new.append(
            Scouter(
                scout_id=scout_id,
                s_number=next_number,
                display_name=_label(scout_id, role),
                role=role,
                bucks=settings.STARTING_BUCKS,
            )
        )
        next_number += 1

    if new:
        repo.save_scouters(new)

    if repo.setting("betting_enabled") == "":
        repo.set_setting("betting_enabled", "1")
