"""Form definitions and their history.

Reading a published form is open to any signed-in account, because every
scouting device needs it to render. Everything that changes a form is admin
and strategy only.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import form_store, repo
from ..auth import current_scouter
from ..forms import (
    CORE_FIELDS,
    FormInvalid,
    KINDS,
    field_type_catalogue,
    missing_core_fields,
    validate_definition,
)
from ..models import Scouter
from ..realtime import emit

router = APIRouter(prefix="/api/forms", tags=["forms"])


def _form_dict(form) -> dict:
    return {
        "form_id": form.form_id,
        "kind": form.kind,
        "season_id": form.season_id,
        "name": form.name,
        "description": form.description,
        "published_version": form.published_version,
        "latest_version": form.latest_version,
        "archived": form.archived,
        "updated_at": form.updated_at.isoformat(),
        "updated_by": form.updated_by,
    }


def _not_found(exc: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail=str(exc))


# --------------------------------------------------------------------------- #
# The builder's own vocabulary                                                 #
# --------------------------------------------------------------------------- #
@router.get("/meta")
def builder_meta(_: Scouter = Depends(current_scouter)) -> dict:
    """Everything the builder needs to render its own controls.

    Served rather than duplicated in TypeScript so that adding a field type is
    a change in one file (app/forms.py) and not two that can drift apart.
    """
    return {
        "field_types": field_type_catalogue(),
        "core_fields": [
            {"key": k, "description": v} for k, v in sorted(CORE_FIELDS.items())
        ],
        "kinds": list(KINDS),
    }


# --------------------------------------------------------------------------- #
# Reading                                                                      #
# --------------------------------------------------------------------------- #
@router.get("")
def list_forms(
    include_archived: bool = False,
    season: Optional[str] = None,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """Forms, scoped to a season by default.

    Pass ``season=all`` to see every season's, which is what the builder's
    season switcher uses.
    """
    from .. import seasons as seasons_mod

    season_id = "" if season == "all" else seasons_mod.resolve(season)
    return [
        _form_dict(f)
        for f in repo.forms(include_archived=include_archived, season_id=season_id)
    ]


@router.get("/active/{kind}")
def active_form(
    kind: str,
    season: Optional[str] = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """The published form of a kind for a season.

    Scouting pages ask for "the pit form for my season" rather than a form ID,
    because IDs are season scoped: a 2027 install has ``2027_pit``, and
    hardcoding a name in the frontend would put the platform right back where
    it started. Also returns the season's game, since a form that asks which
    game piece needs the season to say which pieces exist.
    """
    from .. import seasons as seasons_mod

    season_id = seasons_mod.resolve(season)
    candidates = [f for f in repo.forms(season_id=season_id) if f.kind == kind]
    if not candidates:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Season {season_id or '(none)'} has no {kind} form yet. "
                "An admin creates it in Form Builder."
            ),
        )
    form = candidates[0]
    row = repo.season(season_id)
    return {
        **_form_dict(form),
        "definition": form_store.published_definition(form.form_id),
        "season_id": season_id,
        "game_version": row.game_version if row else 0,
        "game": seasons_mod.definition(season_id).to_dict(),
    }


@router.get("/{form_id}")
def get_form(form_id: str, _: Scouter = Depends(current_scouter)) -> dict:
    """The published definition, which is what a scouting page renders."""
    try:
        form = form_store.get_form(form_id)
    except form_store.FormNotFound as exc:
        raise _not_found(exc) from exc
    return {
        **_form_dict(form),
        "definition": form_store.published_definition(form_id),
    }


@router.get("/{form_id}/history")
def get_history(
    form_id: str,
    limit: int = 100,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    try:
        return form_store.history(form_id, limit)
    except form_store.FormNotFound as exc:
        raise _not_found(exc) from exc


@router.get("/{form_id}/revisions/{version}")
def get_revision(
    form_id: str,
    version: int,
    _: Scouter = Depends(current_scouter),
) -> dict:
    try:
        row = form_store.revision(form_id, version)
    except form_store.FormNotFound as exc:
        raise _not_found(exc) from exc
    return {
        "form_id": row.form_id,
        "version": row.version,
        "parent_version": row.parent_version,
        "message": row.message,
        "author_id": row.author_id,
        "author_name": row.author_name,
        "created_at": row.created_at.isoformat(),
        "reverted_from": row.reverted_from,
        "summary": row.summary,
        "definition": row.definition,
        "warnings": missing_core_fields(row.definition),
    }


@router.get("/{form_id}/diff")
def get_diff(
    form_id: str,
    from_version: int = 0,
    to_version: int = 0,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """What changed between two versions, field by field."""
    try:
        if not to_version:
            to_version = form_store.get_form(form_id).latest_version
        if not from_version:
            from_version = max(0, to_version - 1)
        return form_store.diff(form_id, from_version, to_version)
    except form_store.FormNotFound as exc:
        raise _not_found(exc) from exc


# --------------------------------------------------------------------------- #
# Writing                                                                      #
# --------------------------------------------------------------------------- #
class DefinitionIn(BaseModel):
    definition: dict[str, Any]
    message: str = ""
    publish: bool = True
    #: The version the editor started from, for the optimistic lock. Omit to
    #: skip the check (a scripted import, a first save).
    expected_version: Optional[int] = None


class CreateFormIn(BaseModel):
    form_id: str
    kind: str = "custom"
    definition: dict[str, Any] = Field(default_factory=dict)
    message: str = "Create form"
    season_id: str = ""


class PublishIn(BaseModel):
    version: int


class RevertIn(BaseModel):
    version: int
    message: str = ""


@router.post("/validate")
def validate(
    body: DefinitionIn,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """Check a definition without saving it.

    The builder calls this as you edit, so problems show up next to the field
    that caused them instead of on the way out.
    """
    return {
        "problems": validate_definition(body.definition),
        "warnings": missing_core_fields(body.definition),
    }


@router.post("")
def create(body: CreateFormIn, scouter: Scouter = Depends(current_scouter)) -> dict:
    try:
        row = form_store.create_form(
            body.form_id, body.kind, body.definition, scouter, body.message,
            season_id=body.season_id,
        )
    except FormInvalid as exc:
        raise HTTPException(status_code=422, detail={"problems": exc.problems}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    emit("form_changed", {"form": row.form_id, "version": row.version})
    return {"ok": True, "form_id": row.form_id, "version": row.version}


@router.post("/{form_id}/revisions")
def save(
    form_id: str,
    body: DefinitionIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    try:
        row = form_store.save_revision(
            form_id,
            body.definition,
            scouter,
            body.message,
            publish=body.publish,
            expected_version=body.expected_version,
        )
    except form_store.FormNotFound as exc:
        raise _not_found(exc) from exc
    except FormInvalid as exc:
        raise HTTPException(status_code=422, detail={"problems": exc.problems}) from exc
    except form_store.FormConflict as exc:
        # 409, so the builder can offer to reload rather than retrying blindly.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    emit("form_changed", {"form": form_id, "version": row.version})
    return {
        "ok": True,
        "version": row.version,
        "summary": row.summary,
        "warnings": missing_core_fields(row.definition),
    }


@router.post("/{form_id}/publish")
def publish(
    form_id: str,
    body: PublishIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    try:
        form = form_store.publish(form_id, body.version, scouter)
    except form_store.FormNotFound as exc:
        raise _not_found(exc) from exc
    emit("form_changed", {"form": form_id, "version": body.version})
    return _form_dict(form)


@router.post("/{form_id}/revert")
def revert(
    form_id: str,
    body: RevertIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    """Go back to an older version, by writing a new one that copies it."""
    try:
        row = form_store.revert(form_id, body.version, scouter, body.message)
    except form_store.FormNotFound as exc:
        raise _not_found(exc) from exc
    except FormInvalid as exc:
        raise HTTPException(status_code=422, detail={"problems": exc.problems}) from exc
    emit("form_changed", {"form": form_id, "version": row.version})
    return {
        "ok": True,
        "version": row.version,
        "reverted_from": row.reverted_from,
        "summary": row.summary,
    }


@router.delete("/{form_id}")
def archive(form_id: str, scouter: Scouter = Depends(current_scouter)) -> dict:
    """Archive a form. Its history is kept and it can be restored."""
    try:
        form = form_store.set_archived(form_id, True, scouter)
    except form_store.FormNotFound as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    emit("form_changed", {"form": form_id, "archived": True})
    return _form_dict(form)


@router.post("/{form_id}/restore")
def restore(form_id: str, scouter: Scouter = Depends(current_scouter)) -> dict:
    try:
        form = form_store.set_archived(form_id, False, scouter)
    except form_store.FormNotFound as exc:
        raise _not_found(exc) from exc
    emit("form_changed", {"form": form_id, "archived": False})
    return _form_dict(form)
