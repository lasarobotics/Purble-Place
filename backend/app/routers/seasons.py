"""Seasons and their game definitions.

Reading a season is open to any signed-in account, because every scouting
device needs the game to render its form. Everything that changes a season or
its game is admin and strategy only, and enforced here rather than in the UI.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import repo, seasons
from ..auth import current_scouter
from ..gamedef import FIELD_MAP_MODES, GameDefinition, validate
from ..models import Scouter
from ..realtime import emit

router = APIRouter(prefix="/api/seasons", tags=["seasons"])


def _season_dict(row) -> dict:
    return {
        "season_id": row.season_id,
        "year": row.year,
        "game_name": row.game_name,
        "status": row.status,
        "game_version": row.game_version,
        "copied_from": row.copied_from,
        "notes": row.notes,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
        "updated_by": row.updated_by,
    }


def _not_found(exc: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail=str(exc))


def _invalid(exc: seasons.SeasonInvalid) -> HTTPException:
    return HTTPException(status_code=422, detail={"problems": exc.problems})


# --------------------------------------------------------------------------- #
# Reading                                                                      #
# --------------------------------------------------------------------------- #
@router.get("")
def list_seasons(_: Scouter = Depends(current_scouter)) -> dict:
    return {
        "current": seasons.current_season_id(),
        "seasons": [_season_dict(s) for s in repo.seasons()],
    }


@router.get("/meta")
def meta(_: Scouter = Depends(current_scouter)) -> dict:
    """The vocabulary the season editor renders its own controls from."""
    return {
        "field_map_modes": list(FIELD_MAP_MODES),
        "statuses": ["setup", "active", "archived"],
        "per_modes": ["each", "once"],
        # What a scoring rule may match on. Served rather than duplicated in
        # TypeScript so adding a dimension is one change, not two.
        "rule_dimensions": [
            {"key": "action", "label": "Action", "source": "actions"},
            {"key": "phase", "label": "Phase", "source": "phases"},
            {"key": "object", "label": "Game piece", "source": "pieces"},
            {"key": "location", "label": "Location", "source": "locations"},
            {"key": "result", "label": "Result", "source": "results"},
            {"key": "field", "label": "Form answer", "source": "fields"},
        ],
    }


@router.get("/{season_id}")
def get_season(season_id: str, _: Scouter = Depends(current_scouter)) -> dict:
    try:
        row = seasons.get(season_id)
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc
    return {**_season_dict(row), "definition": row.definition}


@router.get("/{season_id}/checklist")
def get_checklist(season_id: str, _: Scouter = Depends(current_scouter)) -> list[dict]:
    """What is left before this season can run a competition."""
    try:
        return seasons.checklist(season_id)
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc


@router.get("/{season_id}/history")
def get_history(
    season_id: str,
    limit: int = 100,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    try:
        return seasons.history(season_id, limit)
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc


@router.get("/{season_id}/revisions/{version}")
def get_revision(
    season_id: str,
    version: int,
    _: Scouter = Depends(current_scouter),
) -> dict:
    try:
        row = seasons.revision(season_id, version)
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc
    return {
        "season_id": row.season_id,
        "version": row.version,
        "parent_version": row.parent_version,
        "message": row.message,
        "author_name": row.author_name,
        "created_at": row.created_at.isoformat(),
        "reverted_from": row.reverted_from,
        "summary": row.summary,
        "definition": row.definition,
    }


@router.get("/{season_id}/diff")
def get_diff(
    season_id: str,
    from_version: int = 0,
    to_version: int = 0,
    _: Scouter = Depends(current_scouter),
) -> dict:
    try:
        season = seasons.get(season_id)
        to_version = to_version or season.game_version
        from_version = from_version or max(0, to_version - 1)
        before = seasons.revision(season_id, from_version).definition if from_version else {}
        after = seasons.revision(season_id, to_version).definition
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc
    result = seasons.diff_definitions(before, after)
    return {**result, "from": from_version, "to": to_version}


# --------------------------------------------------------------------------- #
# Writing                                                                      #
# --------------------------------------------------------------------------- #
class CreateSeasonIn(BaseModel):
    season_id: str
    year: int
    copy_from: str = ""
    copy_forms: bool = True
    notes: str = ""


class DefinitionIn(BaseModel):
    definition: dict[str, Any] = Field(default_factory=dict)
    message: str = ""
    expected_version: Optional[int] = None


class StatusIn(BaseModel):
    status: str


class RevertIn(BaseModel):
    version: int
    message: str = ""


@router.post("/validate")
def validate_definition(
    body: DefinitionIn,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """Check a game definition without saving it.

    The editor calls this as you type, so a problem shows up next to the thing
    that caused it rather than on the way out.
    """
    return {"problems": validate(GameDefinition.from_dict(body.definition))}


@router.post("")
def create(body: CreateSeasonIn, scouter: Scouter = Depends(current_scouter)) -> dict:
    try:
        row = seasons.create(
            body.season_id,
            body.year,
            scouter,
            copy_from=body.copy_from,
            copy_forms=body.copy_forms,
            notes=body.notes,
        )
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc
    except seasons.SeasonInvalid as exc:
        raise _invalid(exc) from exc
    emit("season_changed", {"season": row.season_id})
    return _season_dict(row)


@router.post("/{season_id}/definition")
def save_definition(
    season_id: str,
    body: DefinitionIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    try:
        row = seasons.save_definition(
            season_id,
            body.definition,
            scouter,
            body.message,
            expected_version=body.expected_version,
        )
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc
    except seasons.SeasonInvalid as exc:
        raise _invalid(exc) from exc
    emit("season_changed", {"season": season_id, "game_version": row.version})
    return {"ok": True, "version": row.version, "summary": row.summary}


@router.post("/{season_id}/revert")
def revert(
    season_id: str,
    body: RevertIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    """Go back to an older game definition, by writing a new one that copies it."""
    try:
        row = seasons.revert(season_id, body.version, scouter, body.message)
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc
    except seasons.SeasonInvalid as exc:
        raise _invalid(exc) from exc
    emit("season_changed", {"season": season_id, "game_version": row.version})
    return {"ok": True, "version": row.version, "reverted_from": row.reverted_from}


@router.post("/{season_id}/status")
def set_status(
    season_id: str,
    body: StatusIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    try:
        row = seasons.set_status(season_id, body.status, scouter)
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc
    except seasons.SeasonInvalid as exc:
        raise _invalid(exc) from exc
    emit("season_changed", {"season": season_id, "status": row.status})
    return _season_dict(row)


@router.post("/{season_id}/seed-forms")
def seed_forms(season_id: str, _: Scouter = Depends(current_scouter)) -> dict:
    """Generate this season's starting match and pit forms from its game.

    Only creates what is missing, so it is safe to press twice and it can
    never overwrite a form somebody has been editing.
    """
    from ..form_store import seed_builtin_forms

    try:
        seasons.get(season_id)
    except seasons.SeasonNotFound as exc:
        raise _not_found(exc) from exc
    seed_builtin_forms(season_id)
    emit("form_changed", {"season": season_id})
    return {
        "ok": True,
        "forms": [f.form_id for f in repo.forms(season_id=season_id)],
    }
