"""Picklists.

Every account keeps two lists per event: a first-pick list and a second-pick
list. Each entry carries the team, its rank (its position in the list) and a
justification the scout typed for that specific pick.

There is no picklist password. Access is decided by account role instead:
anyone can build their own lists, and the picklist meeting screen shows all of
them ranked by whose they are, master first, then strategy and admin, then
scouters.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import repo
from ..auth import current_scouter
from ..models import (
    PICK_FIRST,
    PICK_SECOND,
    PICKLIST_PRIORITY,
    ROLE_SCOUTER,
    Picklist,
    Scouter,
)
from ..realtime import emit

router = APIRouter(prefix="/api/picklists", tags=["picklists"])

MASTER_OWNERS = {"team", "final-418", "final-436"}


def _owner_role(owner_id: str) -> str:
    if owner_id in MASTER_OWNERS:
        return "master"
    owner = repo.scouter(owner_id)
    return owner.role if owner else ROLE_SCOUTER


def _dict(p: Picklist, owner_name: str = "") -> dict:
    role = _owner_role(p.owner_id)
    return {
        "id": p.id,
        "event_key": p.event_key,
        "owner_id": p.owner_id,
        "owner_name": owner_name or _owner_name(p.owner_id),
        "owner_role": role,
        # Lower sorts first. The meeting screen uses this to decide which
        # lists get top billing and which are footnotes.
        "priority": PICKLIST_PRIORITY.get(role, 2),
        "name": p.name,
        "is_master": p.is_master,
        "pick_round": p.pick_round,
        "items": p.items,
        "updated_at": p.updated_at.isoformat(),
    }


def _owner_name(owner_id: str) -> str:
    if owner_id == "team":
        return "Team Master"
    if owner_id.startswith("final-"):
        return f"Final {owner_id.removeprefix('final-')}"
    s = repo.scouter(owner_id)
    return (s.display_name or s.scout_id) if s else owner_id


def _may_edit(p: Picklist, scouter: Scouter) -> bool:
    # Master lists are collaborative for anyone who can be in the room.
    if p.is_master:
        return True
    return True


def _sorted(rows: list[Picklist]) -> list[Picklist]:
    return sorted(
        rows,
        key=lambda p: (
            PICKLIST_PRIORITY.get(_owner_role(p.owner_id), 2),
            p.pick_round,
            _owner_name(p.owner_id).lower(),
        ),
    )


class PicklistIn(BaseModel):
    name: Optional[str] = None
    event_key: Optional[str] = None
    pick_round: int = PICK_FIRST
    items: list[dict[str, Any]] = Field(default_factory=list)


class FinalPicklistIn(BaseModel):
    source_id: Optional[int] = None
    name: Optional[str] = None
    event_key: Optional[str] = None
    pick_round: int = PICK_FIRST
    items: list[dict[str, Any]] = Field(default_factory=list)


def _ensure(event_key: str, owner_id: str, pick_round: int, *, is_master: bool,
            owner_label: str) -> Picklist:
    """Return the owner's list for this pick round, creating it if needed."""
    existing = repo.find_picklist_round(event_key, owner_id, pick_round, is_master)
    if existing is not None:
        return existing
    created = Picklist(
        event_key=event_key,
        owner_id=owner_id,
        name=Picklist.default_name(pick_round, owner_label),
        is_master=is_master,
        pick_round=pick_round,
    )
    repo.save_picklist(created)
    return created


@router.get("/mine")
def get_mine(
    event: str | None = None,
    scouter: Scouter = Depends(current_scouter),
) -> list[dict]:
    """The signed-in account's own first-pick and second-pick lists.

    Both are created on first read, so the UI never has to deal with a
    "no list yet" state.
    """
    event_key = repo.resolve_event(event)
    label = scouter.display_name or scouter.scout_id
    rows = [
        _ensure(event_key, scouter.scout_id, r, is_master=False, owner_label=label)
        for r in (PICK_FIRST, PICK_SECOND)
    ]
    return [_dict(r, label) for r in rows]


@router.get("/master")
def get_master(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """The two shared master lists, created on first read."""
    event_key = repo.resolve_event(event)
    rows = [
        _ensure(event_key, "team", r, is_master=True, owner_label="Master")
        for r in (PICK_FIRST, PICK_SECOND)
    ]
    return [_dict(r) for r in rows]


@router.get("/finals")
def get_finals(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """The locked-in final orders for 418 and 436.

    Every screen where somebody builds a picklist shows these at the top: once
    the alliance order is decided, a scout still tinkering with their own list
    should be able to see what the team actually settled on without going
    looking for it. Collaboratively editable by roster members, and
    absent from the response entirely until a final list has teams in it.
    """
    event_key = repo.resolve_event(event)
    out: list[dict] = []
    for division in ("418", "436"):
        for pick_round in (PICK_FIRST, PICK_SECOND):
            found = repo.find_picklist_round(
                event_key, f"final-{division}", pick_round, True
            )
            if found and found.items:
                out.append({**_dict(found), "division": division})
    return out


@router.get("/all")
def get_all(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """Every picklist at this event, ordered master, then strategy, then scouter."""
    event_key = repo.resolve_event(event)
    return [_dict(r) for r in _sorted(repo.picklists(event_key))]


@router.get("/meeting")
def get_meeting(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    """Everything the picklist meeting screen needs, in one request.

    Grouped rather than sorted so the screen does not have to re-derive which
    lists deserve top billing.
    """
    event_key = repo.resolve_event(event)
    for pick_round in (PICK_FIRST, PICK_SECOND):
        _ensure(event_key, "team", pick_round, is_master=True, owner_label="Master")

    groups: dict[str, list[dict]] = {"master": [], "strategy": [], "scouter": []}
    for row in _sorted(repo.picklists(event_key)):
        data = _dict(row)
        if data["priority"] == 0:
            groups["master"].append(data)
        elif data["priority"] == 1:
            groups["strategy"].append(data)
        else:
            groups["scouter"].append(data)
    return {"event": event_key, **groups}


@router.post("/finals/{division}")
def set_final(
    division: str,
    body: FinalPicklistIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    if division not in {"418", "436"}:
        raise HTTPException(status_code=400, detail="Final picklist must be for 418 or 436")

    event_key = repo.resolve_event(body.event_key)
    items = body.items
    if body.source_id is not None:
        source = repo.picklist(body.source_id)
        if not source:
            raise HTTPException(status_code=404, detail="Source picklist not found")
        if event_key and source.event_key != event_key:
            raise HTTPException(status_code=400, detail="Source picklist is for a different event")
        items = source.items

    owner_id = f"final-{division}"
    final = _ensure(
        event_key, owner_id, body.pick_round, is_master=True,
        owner_label=f"Final {division}",
    )
    final.name = body.name or final.name
    final.items = Picklist.normalize_items(items)
    repo.save_picklist(final)
    emit("picklist_changed", {"id": final.id, "master": True, "final": division})
    return _dict(final)


@router.delete("/finals/{division}")
def clear_final(
    division: str,
    pick_round: int = PICK_FIRST,
    event: str | None = None,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    """Empty a final list so it disappears from the meeting screens again.

    The document itself is kept rather than deleted: ``/finals`` only returns
    lists that have teams in them, so emptying is what "delete" means here,
    and keeping the row means the next promotion reuses the same ID instead of
    leaving orphans behind.
    """
    if division not in {"418", "436"}:
        raise HTTPException(status_code=400, detail="Final picklist must be for 418 or 436")

    event_key = repo.resolve_event(event)
    found = repo.find_picklist_round(event_key, f"final-{division}", pick_round, True)
    if not found:
        raise HTTPException(status_code=404, detail=f"No final {division} list for this pick")
    found.items = []
    repo.save_picklist(found)
    emit("picklist_changed", {"id": found.id, "master": True, "final": division})
    return {"ok": True, "division": division, "pick_round": pick_round}


@router.post("")
def create(
    body: PicklistIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(body.event_key)
    label = scouter.display_name or scouter.scout_id
    p = Picklist(
        event_key=event_key,
        owner_id=scouter.scout_id,
        name=body.name or Picklist.default_name(body.pick_round, label),
        is_master=False,
        pick_round=body.pick_round,
        items=Picklist.normalize_items(body.items),
    )
    repo.save_picklist(p)
    emit("picklist_changed", {"id": p.id})
    return _dict(p, label)


@router.put("/{pid}")
def update(
    pid: int,
    body: PicklistIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    p = repo.picklist(pid)
    if not p:
        raise HTTPException(status_code=404, detail="Picklist not found")
    if not _may_edit(p, scouter):
        raise HTTPException(status_code=403, detail="Not your picklist")
    if body.name:
        p.name = body.name
    p.items = Picklist.normalize_items(body.items)
    repo.save_picklist(p)
    emit("picklist_changed", {"id": p.id, "master": p.is_master})
    return _dict(p)


@router.delete("/{pid}")
def delete(
    pid: int,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    p = repo.picklist(pid)
    if not p:
        raise HTTPException(status_code=404, detail="Picklist not found")
    if p.is_master:
        raise HTTPException(status_code=400, detail="Cannot delete a master list")
    if not _may_edit(p, scouter):
        raise HTTPException(status_code=403, detail="Not your picklist")
    repo.delete_picklist(pid)
    emit("picklist_changed", {"deleted": pid})
    return {"ok": True}
