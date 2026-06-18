"""Seed the admin account + demo scouters (1, 2, 3)."""
from __future__ import annotations

from sqlmodel import Session

from .config import settings
from .database import engine
from .models import Scouter
from .store import set_setting, get_setting

DEMO_IDS = ["1", "2", "3"]


def seed() -> None:
    with Session(engine) as session:
        # Admin
        if session.get(Scouter, settings.ADMIN_ID) is None:
            session.add(
                Scouter(
                    scout_id=settings.ADMIN_ID,
                    display_name="Administrator",
                    is_admin=True,
                    bucks=settings.STARTING_BUCKS,
                )
            )
        # Demo scouters
        for sid in DEMO_IDS:
            if session.get(Scouter, sid) is None:
                session.add(
                    Scouter(
                        scout_id=sid,
                        display_name=f"Scout {sid}",
                        is_admin=False,
                        bucks=settings.STARTING_BUCKS,
                    )
                )
        session.commit()

        # Ensure defaults exist
        for key in ("betting_enabled",):
            if get_setting(session, key) == "":
                set_setting(session, key, "1")
