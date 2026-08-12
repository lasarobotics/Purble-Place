"""Seed the admin account + demo scouters (1, 2, 3).

Runs on every boot but writes nothing when the documents already exist — the
cache's dirty check turns a warm start into zero Firestore operations.
"""
from __future__ import annotations

from . import repo
from .config import settings
from .models import Scouter

DEMO_IDS = ["1", "2", "3"]


def seed() -> None:
    new: list[Scouter] = []
    next_number = repo.next_s_number()

    if repo.scouter(settings.ADMIN_ID) is None:
        new.append(
            Scouter(
                scout_id=settings.ADMIN_ID,
                s_number=next_number,
                display_name="Administrator",
                is_admin=True,
                bucks=settings.STARTING_BUCKS,
            )
        )
        next_number += 1

    for sid in DEMO_IDS:
        if repo.scouter(sid) is None:
            new.append(
                Scouter(
                    scout_id=sid,
                    s_number=next_number,
                    display_name=f"Scout {sid}",
                    is_admin=False,
                    bucks=settings.STARTING_BUCKS,
                )
            )
            next_number += 1

    if new:
        repo.save_scouters(new)

    # Ensure defaults exist.
    if repo.setting("betting_enabled") == "":
        repo.set_setting("betting_enabled", "1")
