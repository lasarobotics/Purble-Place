"""Form history: append-only, attributed, revertible.

The rules, which are borrowed from version control on purpose:

* **Nothing is ever edited in place.** Saving writes a new revision with a new
  version number. The old one stays exactly as it was, forever.
* **Every revision has an author and a message.** Six weeks after a
  competition, "who dropped the defense rating and why" has an answer.
* **Publishing is separate from saving.** A revision can be drafted and looked
  at before scouts start filling it in, which matters because a form change
  lands on sixty devices at once.
* **Reverting moves forward, not back.** Going back to version 3 writes
  version 9 whose definition is a copy of 3, and records that it came from
  there. History is never rewritten, so a revert is itself reviewable and
  itself revertible.
* **Deleting is archiving.** A form keeps its history and can be restored.
  Losing a season of form design to a mis-tap is not a recoverable action, so
  it is not an available one.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from . import repo
from .forms import (
    KINDS,
    KIND_CUSTOM,
    KIND_MATCH,
    KIND_PIT,
    diff_definitions,
    ensure_valid,
    summarize_diff,
)
from .models import Form, FormRevision, Scouter

log = logging.getLogger("hazehub.forms")


def _now() -> datetime:
    return datetime.now(timezone.utc)


class FormNotFound(LookupError):
    pass


class FormConflict(RuntimeError):
    """The form moved under the editor's feet."""


# --------------------------------------------------------------------------- #
# Reading                                                                      #
# --------------------------------------------------------------------------- #
def get_form(form_id: str) -> Form:
    row = repo.form(form_id)
    if row is None:
        raise FormNotFound(f"No form called {form_id!r}")
    return row


def published_definition(form_id: str) -> dict[str, Any]:
    """What scouts are filling in right now.

    Falls back to the latest revision when nothing has been published yet, so
    a form created and never explicitly published still renders rather than
    showing an empty page.
    """
    form = get_form(form_id)
    version = form.published_version or form.latest_version
    revision = repo.form_revision(form_id, version) if version else None
    return revision.definition if revision else {}


def history(form_id: str, limit: int = 100) -> list[dict[str, Any]]:
    form = get_form(form_id)
    return [
        {
            "version": r.version,
            "parent_version": r.parent_version,
            "message": r.message,
            "author_id": r.author_id,
            "author_name": r.author_name,
            "created_at": r.created_at.isoformat(),
            "reverted_from": r.reverted_from,
            "summary": r.summary,
            "published": r.version == form.published_version,
            "latest": r.version == form.latest_version,
        }
        for r in repo.form_revisions(form_id, limit)
    ]


def revision(form_id: str, version: int) -> FormRevision:
    row = repo.form_revision(form_id, version)
    if row is None:
        raise FormNotFound(f"{form_id} has no version {version}")
    return row


def diff(form_id: str, from_version: int, to_version: int) -> dict[str, Any]:
    """What changed between two versions. ``from_version`` 0 means "empty"."""
    before = revision(form_id, from_version).definition if from_version else {"sections": []}
    after = revision(form_id, to_version).definition
    result = diff_definitions(before, after)
    result["from"] = from_version
    result["to"] = to_version
    return result


# --------------------------------------------------------------------------- #
# Writing                                                                      #
# --------------------------------------------------------------------------- #
def save_revision(
    form_id: str,
    definition: dict[str, Any],
    author: Scouter,
    message: str = "",
    *,
    publish: bool = True,
    expected_version: Optional[int] = None,
    reverted_from: int = 0,
) -> FormRevision:
    """Write a new revision of a form.

    ``expected_version`` is an optimistic lock. Two strategy leads editing the
    same form during a build session is normal, and without this the second
    save silently discards the first. When it does not match, the caller is
    told which version it is now on and can re-open rather than overwrite.
    """
    form = get_form(form_id)
    ensure_valid(definition)

    if expected_version is not None and expected_version != form.latest_version:
        raise FormConflict(
            f"This form is now at version {form.latest_version}, but you started "
            f"from version {expected_version}. Re-open it so you do not "
            "overwrite somebody else's edit."
        )

    parent = form.latest_version
    previous = repo.form_revision(form_id, parent) if parent else None
    before = previous.definition if previous else {"sections": []}
    summary = summarize_diff(diff_definitions(before, definition))

    version = parent + 1
    row = FormRevision(
        form_id=form_id,
        version=version,
        definition=definition,
        parent_version=parent,
        message=message.strip(),
        author_id=author.scout_id,
        author_name=author.display_name or author.scout_id,
        reverted_from=reverted_from,
        summary=summary,
    )
    repo.save_form_revision(row)

    form.latest_version = version
    if publish:
        form.published_version = version
    form.name = definition.get("name") or form.name
    form.description = definition.get("description") or form.description
    form.updated_at = _now()
    form.updated_by = row.author_name
    repo.save_form(form)

    log.info(
        "form %s v%d by %s: %s", form_id, version, row.author_name, summary
    )
    return row


def publish(form_id: str, version: int, author: Scouter) -> Form:
    """Point scouts at an existing revision."""
    form = get_form(form_id)
    revision(form_id, version)  # 404s if it does not exist
    form.published_version = version
    form.updated_at = _now()
    form.updated_by = author.display_name or author.scout_id
    repo.save_form(form)
    return form


def revert(form_id: str, to_version: int, author: Scouter, message: str = "") -> FormRevision:
    """Go back to an older version by moving forward to a copy of it.

    Deleting the revisions in between would destroy the record of what was
    tried, which is the part somebody needs when the same mistake comes up
    again next season.
    """
    target = revision(form_id, to_version)
    text = message.strip() or f"Revert to version {to_version}"
    return save_revision(
        form_id,
        target.definition,
        author,
        text,
        publish=True,
        reverted_from=to_version,
    )


def create_form(
    form_id: str,
    kind: str,
    definition: dict[str, Any],
    author: Scouter,
    message: str = "Create form",
    season_id: str = "",
) -> FormRevision:
    form_id = (form_id or "").strip().lower()
    if not form_id.replace("_", "").replace("-", "").isalnum():
        raise ValueError(
            "A form ID may only contain letters, numbers, hyphens and underscores."
        )
    if repo.form(form_id) is not None:
        raise ValueError(f"A form called {form_id!r} already exists.")
    if kind not in KINDS:
        kind = KIND_CUSTOM

    ensure_valid(definition)
    from . import seasons

    repo.save_form(
        Form(
            form_id=form_id,
            kind=kind,
            name=definition.get("name") or form_id,
            description=definition.get("description") or "",
            season_id=season_id or seasons.current_season_id(),
            updated_by=author.display_name or author.scout_id,
        )
    )
    return save_revision(form_id, definition, author, message, publish=True)


def set_archived(form_id: str, archived: bool, author: Scouter) -> Form:
    """Archive or restore a form. The history is untouched either way."""
    form = get_form(form_id)
    if form.kind in ("match", "pit") and archived:
        raise ValueError(
            "The match and pit forms cannot be deleted, because the scouting "
            "and pit pages render from them. Edit them instead, or revert to "
            "an older version."
        )
    form.archived = archived
    form.updated_at = _now()
    form.updated_by = author.display_name or author.scout_id
    repo.save_form(form)
    return form


# --------------------------------------------------------------------------- #
# Seeding                                                                      #
# --------------------------------------------------------------------------- #
#: Author recorded on the revisions a fresh install starts with, so the very
#: first entry in every history says where the form came from.
SYSTEM = Scouter(scout_id="system", display_name="HazeHub (built in)")


def seed_builtin_forms(season_id: str = "") -> None:
    """Create a season's match and pit forms if it has none.

    Only ever creates. An install that has edited its forms must never have
    them reset by a deploy, so an existing form is left completely alone.

    The templates are generated from the season's own game definition, which
    is what makes a newly created 2027 season start with a form that asks
    about the 2027 game rather than last year's.
    """
    from . import seasons
    from .forms import default_match_form, default_pit_form

    season_id = season_id or seasons.current_season_id()
    if not season_id:
        return
    game = seasons.definition(season_id)

    templates = {
        f"{season_id}_match": (KIND_MATCH, default_match_form(game)),
        f"{season_id}_pit": (KIND_PIT, default_pit_form(game)),
    }
    for form_id, (kind, definition) in templates.items():
        if repo.form(form_id) is not None:
            continue
        # An install that predates seasons has forms called plainly "match"
        # and "pit". Adopt those rather than creating a duplicate beside them.
        legacy = repo.form(kind)
        if legacy is not None and not legacy.season_id:
            legacy.season_id = season_id
            repo.save_form(legacy)
            log.info("adopted legacy form %s into season %s", kind, season_id)
            continue
        create_form(form_id, kind, definition, SYSTEM,
                    f"Starting {kind} form for {season_id}", season_id=season_id)
        log.info("created %s form for season %s", kind, season_id)
