"""Write the account roster into the datastore.

Runs on every boot but writes nothing when the documents already exist, so a
warm start costs zero Firestore operations.

Unlike earlier builds, this is not "starter data you can add to". The roster
in ``settings.ACCOUNTS`` is the complete list of accounts, sign-in refuses
anything else (see ``auth.get_account``), and these documents are what the
rest of the app reads roles and balances from.
"""
from __future__ import annotations

from . import repo, schema
from .auth import role_for_new_account
from .cache import store
from .config import settings
from .models import ROLE_ADMIN, ROLE_PICKLIST, ROLE_STRATEGY, Scouter


def _label(scout_id: str, role: str) -> str:
    """A human name for the sidebar, since the IDs are terse by design."""
    if role == ROLE_ADMIN:
        return "Administrator"
    if role == ROLE_STRATEGY:
        return "Strategy"
    if role == ROLE_PICKLIST:
        return "Picklist Meeting"
    if scout_id.isdigit():
        return f"Scout {scout_id}"
    return scout_id


def _legacy_ids() -> dict[str, str]:
    """``{existing document ID: roster ID}`` for accounts that need renaming.

    Two sources. The explicit aliases cover a genuine rename (``picklist`` ->
    ``PicklistMeeting``). The scan covers a change of capitalisation: sign-in
    matches case-insensitively, but a Firestore document ID does not, so an
    installation that already had ``admin`` would otherwise end up with a
    second, empty ``Admin`` beside it.
    """
    canonical_by_key = {c.lower(): c for c in settings.ACCOUNTS}
    out: dict[str, str] = {}

    for legacy, canonical in settings.ACCOUNT_ALIASES.items():
        if canonical in settings.ACCOUNTS and legacy != canonical:
            out[legacy] = canonical

    for existing in repo.scouters():
        canonical = canonical_by_key.get(existing.scout_id.lower())
        if canonical and canonical != existing.scout_id:
            out[existing.scout_id] = canonical

    return out


def _migrate_legacy_ids() -> None:
    """Move accounts the roster now spells differently onto their new ID.

    Copying the old document over keeps its Purple Bucks and scouting count
    instead of silently starting the account from scratch, and the old
    document is removed so it cannot be signed into or appear twice in the
    admin account table.
    """
    for legacy, canonical in _legacy_ids().items():
        old = repo.scouter(legacy)
        if old is None or repo.scouter(canonical) is not None:
            continue
        moved = Scouter(
            scout_id=canonical,
            password_hash=old.password_hash,
            s_number=old.s_number,
            display_name=old.display_name or _label(canonical, old.role),
            active=old.active,
            deleted=old.deleted,
            name_confirmed=old.name_confirmed,
            auth_revision=old.auth_revision,
            role=old.role,
            bucks=old.bucks,
            matches_scouted=old.matches_scouted,
            created_at=old.created_at,
        )
        repo.save_scouter(moved)
        store.delete(schema.SCOUTERS, legacy)


def seed() -> None:
    _migrate_legacy_ids()

    # The configured roster seeds missing accounts only. Admin-managed users,
    # roles, deactivations, names and historical attribution survive deployments.

    new: list[Scouter] = []
    next_number = repo.next_s_number()

    for scout_id in settings.ACCOUNTS:
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
