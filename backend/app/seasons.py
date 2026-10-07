"""Seasons: creating them, changing the game, and never breaking last year.

A season is the unit that owns a game definition, the forms built for it, and
everything scouted through those forms. Making it first class is what answers
the January question: a new game is a new season, configured in the app, not a
new branch of the application.

Three rules hold this together.

**A game definition is never edited in place.** Saving writes a revision, the
season's ``game_version`` moves to it, and the old revision stays readable
forever. Reverting writes another revision that copies an old one, exactly as
forms do, so the record of what was tried survives the decision to undo it.

**Every submission pins the version it was collected under.** Scoring a 2026
report reads the 2026 definition, whatever the rules say today. That is the
whole reason the versions are kept.

**Creating a season never touches an existing one.** Duplicating copies the
game configuration and the forms; it does not copy events, scouting, picklists
or archives, because those belong to the season that produced them.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

from . import repo
from .gamedef import GameDefinition, bootstrap_2026, validate
from .models import (
    SEASON_ACTIVE,
    SEASON_ARCHIVED,
    SEASON_SETUP,
    SEASON_STATUSES,
    Season,
    SeasonRevision,
    Scouter,
)

log = logging.getLogger("hazehub.seasons")

#: Where the current season pointer lives, alongside the current event.
CURRENT_SEASON_SETTING = "current_season"

SEASON_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

#: Author on the revisions a fresh install starts with.
SYSTEM = Scouter(scout_id="system", display_name="HazeHub (built in)")


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SeasonNotFound(LookupError):
    pass


class SeasonInvalid(ValueError):
    """A game definition that cannot be saved, with every problem listed."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


# --------------------------------------------------------------------------- #
# Reading                                                                      #
# --------------------------------------------------------------------------- #
def get(season_id: str) -> Season:
    row = repo.season(season_id)
    if row is None:
        raise SeasonNotFound(f"No season called {season_id!r}")
    return row


def current_season_id() -> str:
    """The season everything defaults to.

    Falls back to the only active season, then to the newest, so an install
    whose pointer was never set still works rather than showing nothing.
    """
    pointer = repo.setting(CURRENT_SEASON_SETTING).strip()
    if pointer and repo.season(pointer) is not None:
        return pointer

    rows = repo.seasons()
    active = [s for s in rows if s.status == SEASON_ACTIVE]
    chosen = (active or rows or [None])[0]
    return chosen.season_id if chosen else ""


def resolve(season_id: Optional[str]) -> str:
    return (season_id or current_season_id()).strip()


def definition(season_id: Optional[str] = None) -> GameDefinition:
    """The game definition in force for a season, right now."""
    row = repo.season(resolve(season_id))
    return GameDefinition.from_dict(row.definition) if row else bootstrap_2026()


def definition_at(season_id: str, version: int) -> GameDefinition:
    """The definition as it was at a given version.

    This is what scoring a historical submission goes through, so a rule
    change today cannot reach backwards into last season's numbers.
    """
    if version:
        revision = repo.season_revision(season_id, version)
        if revision is not None:
            return GameDefinition.from_dict(revision.definition)
    return definition(season_id)


def history(season_id: str, limit: int = 100) -> list[dict[str, Any]]:
    season = get(season_id)
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
            "current": r.version == season.game_version,
        }
        for r in repo.season_revisions(season_id, limit)
    ]


def revision(season_id: str, version: int) -> SeasonRevision:
    row = repo.season_revision(season_id, version)
    if row is None:
        raise SeasonNotFound(f"{season_id} has no game version {version}")
    return row


# --------------------------------------------------------------------------- #
# Change summaries                                                             #
# --------------------------------------------------------------------------- #
_COUNTED = ("phases", "pieces", "locations", "actions", "rules", "endgame", "tags")


def diff_definitions(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """What changed between two game definitions, per collection.

    Keyed on each item's own identifier rather than its position, so
    reordering the rules is not reported as replacing all of them.
    """
    def index(data: dict[str, Any], group: str) -> dict[str, dict]:
        key = "rule_id" if group == "rules" else ("tag" if group == "tags" else "key")
        return {str(item.get(key)): item for item in (data.get(group) or [])}

    out: dict[str, Any] = {"groups": {}, "total": 0}
    for group in _COUNTED:
        old, new = index(before or {}, group), index(after or {}, group)
        added = sorted(set(new) - set(old))
        removed = sorted(set(old) - set(new))
        changed = sorted(k for k in set(old) & set(new) if old[k] != new[k])
        if added or removed or changed:
            out["groups"][group] = {
                "added": added, "removed": removed, "changed": changed
            }
            out["total"] += len(added) + len(removed) + len(changed)

    for scalar in ("name", "year", "endgame_label"):
        if (before or {}).get(scalar) != (after or {}).get(scalar):
            out.setdefault("scalars", {})[scalar] = {
                "from": (before or {}).get(scalar), "to": (after or {}).get(scalar)
            }
            out["total"] += 1

    if (before or {}).get("field_map") != (after or {}).get("field_map"):
        out["field_map_changed"] = True
        out["total"] += 1

    return out


def summarize(diff: dict[str, Any]) -> str:
    """One line for the history list."""
    parts = []
    for group, delta in (diff.get("groups") or {}).items():
        bits = []
        for kind in ("added", "removed", "changed"):
            count = len(delta.get(kind) or [])
            if count:
                bits.append(f"{count} {kind}")
        if bits:
            parts.append(f"{group}: {', '.join(bits)}")
    if diff.get("scalars"):
        parts.append(", ".join(sorted(diff["scalars"])) + " changed")
    if diff.get("field_map_changed"):
        parts.append("field map changed")
    return "; ".join(parts) or "no changes"


# --------------------------------------------------------------------------- #
# Writing                                                                      #
# --------------------------------------------------------------------------- #
def save_definition(
    season_id: str,
    game: GameDefinition | dict[str, Any],
    author: Scouter,
    message: str = "",
    *,
    expected_version: Optional[int] = None,
    reverted_from: int = 0,
) -> SeasonRevision:
    """Write a new version of a season's game definition.

    ``expected_version`` is an optimistic lock, for the same reason forms have
    one: two people configuring a new game in the same week is normal, and a
    last-write-wins save quietly throws one of their afternoons away.
    """
    season = get(season_id)
    parsed = game if isinstance(game, GameDefinition) else GameDefinition.from_dict(game)

    problems = validate(parsed)
    if problems:
        raise SeasonInvalid(problems)

    if expected_version is not None and expected_version != season.game_version:
        raise SeasonInvalid([
            f"This game is now at version {season.game_version}, but you started "
            f"from version {expected_version}. Re-open it so you do not overwrite "
            "somebody else's edit."
        ])

    data = parsed.to_dict()
    summary = summarize(diff_definitions(season.definition, data))
    version = season.game_version + 1

    row = SeasonRevision(
        season_id=season_id,
        version=version,
        definition=data,
        parent_version=season.game_version,
        message=message.strip(),
        author_id=author.scout_id,
        author_name=author.display_name or author.scout_id,
        reverted_from=reverted_from,
        summary=summary,
    )
    repo.save_season_revision(row)

    season.definition = data
    season.game_version = version
    season.game_name = parsed.name or season.game_name
    season.year = parsed.year or season.year
    season.updated_at = _now()
    season.updated_by = row.author_name
    repo.save_season(season)

    log.info("season %s game v%d by %s: %s", season_id, version, row.author_name, summary)
    return row


def revert(season_id: str, to_version: int, author: Scouter, message: str = "") -> SeasonRevision:
    """Go back to an older game definition by moving forward to a copy of it."""
    target = revision(season_id, to_version)
    text = message.strip() or f"Revert game to version {to_version}"
    return save_definition(
        season_id,
        GameDefinition.from_dict(target.definition),
        author,
        text,
        reverted_from=to_version,
    )


def create(
    season_id: str,
    year: int,
    author: Scouter,
    *,
    game: GameDefinition | None = None,
    copy_from: str = "",
    copy_forms: bool = True,
    notes: str = "",
) -> Season:
    """Start a new season.

    ``copy_from`` duplicates another season's game configuration and, unless
    told otherwise, its forms. It deliberately copies *configuration only*:
    events, scouting, picklists and archives stay with the season that
    produced them, because that is the entire point of having seasons.
    """
    season_id = (season_id or "").strip().lower()
    if not SEASON_ID_PATTERN.match(season_id):
        raise SeasonInvalid([
            "A season ID may only contain lower case letters, numbers, hyphens "
            "and underscores, and must start with a letter or number."
        ])
    if repo.season(season_id) is not None:
        raise SeasonInvalid([f"A season called {season_id!r} already exists."])

    source: Optional[Season] = None
    if copy_from:
        source = get(copy_from)
        game = GameDefinition.from_dict(source.definition)
        game.year = year or game.year
    if game is None:
        game = GameDefinition(name="", year=year)

    problems = [p for p in validate(game) if "needs a name" not in p]
    if problems:
        raise SeasonInvalid(problems)

    season = Season(
        season_id=season_id,
        year=year,
        game_name=game.name,
        status=SEASON_SETUP,
        definition={},
        game_version=0,
        copied_from=source.season_id if source else "",
        notes=notes,
        updated_by=author.display_name or author.scout_id,
    )
    repo.save_season(season)

    # Version 1 is always a real revision, so the history never starts blank.
    save_definition(
        season_id,
        game,
        author,
        f"Copied from {source.season_id}" if source else "New season",
    )

    if source and copy_forms:
        _copy_forms(source.season_id, season_id, author)

    log.info("created season %s (%d)", season_id, year)
    return get(season_id)


def _copy_forms(from_season: str, to_season: str, author: Scouter) -> int:
    """Copy a season's published forms into a new season.

    Imported late to keep the module graph acyclic: form_store reads seasons
    to know which season a form belongs to.
    """
    from . import form_store

    copied = 0
    for form in repo.forms(include_archived=False):
        if form.season_id != from_season:
            continue
        published = form_store.published_definition(form.form_id)
        if not published:
            continue
        new_id = f"{to_season}_{form.form_id.split('_', 1)[-1]}"
        if repo.form(new_id) is not None:
            continue
        form_store.create_form(
            new_id,
            form.kind,
            published,
            author,
            f"Copied from {from_season}",
            season_id=to_season,
        )
        copied += 1
    return copied


def set_status(season_id: str, status: str, author: Scouter) -> Season:
    """Move a season between setup, active and archived.

    Only one season is active at a time. Activating a new one archives the
    old, which is what stops next year's game being configured into this
    year's live competition by accident.
    """
    if status not in SEASON_STATUSES:
        raise SeasonInvalid([f"Status must be one of {', '.join(SEASON_STATUSES)}."])
    season = get(season_id)

    if status == SEASON_ACTIVE:
        for other in repo.seasons():
            if other.season_id != season_id and other.status == SEASON_ACTIVE:
                other.status = SEASON_ARCHIVED
                other.updated_at = _now()
                repo.save_season(other)
        repo.set_setting(CURRENT_SEASON_SETTING, season_id)

    season.status = status
    season.updated_at = _now()
    season.updated_by = author.display_name or author.scout_id
    repo.save_season(season)
    return season


# --------------------------------------------------------------------------- #
# Setup checklist                                                              #
# --------------------------------------------------------------------------- #
def checklist(season_id: str) -> list[dict[str, Any]]:
    """What is left before a season can run a competition.

    Read straight off the definition rather than tracked as flags, so it can
    never disagree with the thing it is describing.
    """
    season = get(season_id)
    game = GameDefinition.from_dict(season.definition)
    forms = [f for f in repo.forms(include_archived=False) if f.season_id == season_id]

    def item(key, label, done, hint):
        return {"key": key, "label": label, "done": bool(done), "hint": hint}

    match_form = next((f for f in forms if f.kind == "match"), None)
    pit_form = next((f for f in forms if f.kind == "pit"), None)

    return [
        item("season", "Season created", True, ""),
        item("game", "Game named", bool(game.name), "Give the game its name."),
        item("phases", "Phases configured", bool(game.phases),
             "Add at least one phase, such as Teleop."),
        item("pieces", "Game pieces configured", bool(game.pieces),
             "Add the objects robots handle."),
        item("locations", "Locations configured", bool(game.locations),
             "Add the places scoring happens."),
        item("actions", "Actions configured", bool(game.actions),
             "Add what a robot can do, such as Score."),
        item("scoring", "Scoring configured", bool(game.rules),
             "Add the rules that turn actions into points."),
        item("endgame", "Endgame configured", bool(game.endgame),
             "Add the endgame states, even if there is only one."),
        item("field", "Field map configured", bool(game.field_map.image),
             "Upload the field image for this season."),
        item("match_form", "Match scouting form", bool(match_form),
             "Build it in Form Builder."),
        item("pit_form", "Pit scouting form", bool(pit_form),
             "Build it in Form Builder."),
        item("published", "Season active", season.status == SEASON_ACTIVE,
             "Make this the season scouts are working in."),
    ]


# --------------------------------------------------------------------------- #
# Seeding                                                                      #
# --------------------------------------------------------------------------- #
def seed_first_season() -> None:
    """Create the 2026 season on a fresh install, and never touch it again."""
    if repo.seasons():
        if not repo.setting(CURRENT_SEASON_SETTING).strip():
            repo.set_setting(CURRENT_SEASON_SETTING, current_season_id())
        return

    game = bootstrap_2026()
    create(str(game.year), game.year, SYSTEM, game=game)
    set_status(str(game.year), SEASON_ACTIVE, SYSTEM)
    log.info("created the first season from the built-in 2026 definition")
