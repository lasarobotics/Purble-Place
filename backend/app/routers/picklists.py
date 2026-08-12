"""Picklists — personal lists plus a collaborative master list."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import repo
from ..auth import current_scouter
from ..models import Picklist, Scouter
from ..realtime import emit

router = APIRouter(prefix="/api/picklists", tags=["picklists"])


def _dict(p: Picklist, owner_name: str = "") -> dict:
    return {
        "id": p.id,
        "event_key": p.event_key,
        "owner_id": p.owner_id,
        "owner_name": owner_name or p.owner_id,
        "name": p.name,
        "is_master": p.is_master,
        "items": p.items,
        "updated_at": p.updated_at.isoformat(),
    }


def _owner_name(owner_id: str) -> str:
    s = repo.scouter(owner_id)
    return (s.display_name or s.scout_id) if s else owner_id


class PicklistIn(BaseModel):
    name: str = "My Picklist"
    event_key: Optional[str] = None
    items: list[dict[str, Any]] = Field(default_factory=list)
    is_master: bool = False


class FinalPicklistIn(BaseModel):
    source_id: Optional[int] = None
    name: Optional[str] = None
    event_key: Optional[str] = None
    items: list[dict[str, Any]] = Field(default_factory=list)


def _ensure_master(event_key: str) -> Picklist:
    master = repo.find_picklist(event_key, "team", is_master=True)
    if master is None:
        master = Picklist(
            event_key=event_key, owner_id="team", name="Master Picklist", is_master=True
        )
        repo.save_picklist(master)
    return master


@router.get("/master")
def get_master(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(event)
    return _dict(_ensure_master(event_key))


@router.get("/mine")
def get_mine(
    event: str | None = None,
    scouter: Scouter = Depends(current_scouter),
) -> list[dict]:
    event_key = repo.resolve_event(event)
    rows = [
        p for p in repo.picklists(event_key)
        if p.owner_id == scouter.scout_id and not p.is_master
    ]
    return [_dict(r, scouter.display_name) for r in rows]


@router.get("/all")
def get_all(
    event: str | None = None,
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """Every picklist (personal + master) so the team can follow along."""
    event_key = repo.resolve_event(event)
    rows = repo.picklists(event_key)
    rows.sort(key=lambda r: (not r.is_master, r.updated_at))
    return [_dict(r, _owner_name(r.owner_id)) for r in rows]


@router.post("/finals/{division}")
def set_final(
    division: str,
    body: FinalPicklistIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    if not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    if division not in {"418", "436"}:
        raise HTTPException(status_code=400, detail="Final picklist must be for 418 or 436")

    event_key = repo.resolve_event(body.event_key)
    items = body.items
    source_name = ""
    if body.source_id is not None:
        source = repo.picklist(body.source_id)
        if not source:
            raise HTTPException(status_code=404, detail="Source picklist not found")
        if event_key and source.event_key != event_key:
            raise HTTPException(status_code=400, detail="Source picklist is for a different event")
        items = source.items
        source_name = source.name

    owner_id = f"final-{division}"
    final = repo.find_picklist(event_key, owner_id, is_master=True)
    if final is None:
        final = Picklist(event_key=event_key, owner_id=owner_id, is_master=True)

    final.name = body.name or f"Final Picklist {division}"
    final.items = Picklist.normalize_items(items)
    repo.save_picklist(final)
    emit("picklist_changed", {"id": final.id, "master": True, "final": division, "source": source_name})
    return _dict(final, f"Final {division}")


@router.post("")
def create(
    body: PicklistIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    event_key = repo.resolve_event(body.event_key)
    p = Picklist(
        event_key=event_key,
        owner_id=scouter.scout_id,
        name=body.name,
        is_master=False,
        items=Picklist.normalize_items(body.items),
    )
    repo.save_picklist(p)
    emit("picklist_changed", {"id": p.id})
    return _dict(p, scouter.display_name)


@router.put("/{pid}")
def update(
    pid: int,
    body: PicklistIn,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    p = repo.picklist(pid)
    if not p:
        raise HTTPException(status_code=404, detail="Picklist not found")
    # Master is collaborative (anyone may edit); personal lists are owner/admin.
    if not p.is_master and p.owner_id != scouter.scout_id and not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Not your picklist")
    p.name = body.name or p.name
    p.items = Picklist.normalize_items(body.items)
    repo.save_picklist(p)
    emit("picklist_changed", {"id": p.id, "master": p.is_master})
    return _dict(p, _owner_name(p.owner_id))


@router.delete("/{pid}")
def delete(
    pid: int,
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    p = repo.picklist(pid)
    if not p:
        raise HTTPException(status_code=404, detail="Picklist not found")
    if p.is_master:
        raise HTTPException(status_code=400, detail="Cannot delete the master list")
    if p.owner_id != scouter.scout_id and not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Not your picklist")
    repo.delete_picklist(pid)
    emit("picklist_changed", {"deleted": pid})
    return {"ok": True}
