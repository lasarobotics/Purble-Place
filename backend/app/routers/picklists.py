"""Picklists — personal lists plus a collaborative master list."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..auth import current_scouter
from ..database import get_session
from ..models import Picklist, Scouter
from ..realtime import emit
from ..store import get_setting

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


def _owner_name(session: Session, owner_id: str) -> str:
    s = session.get(Scouter, owner_id)
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


def _ensure_master(session: Session, event_key: str) -> Picklist:
    master = session.exec(
        select(Picklist).where(
            Picklist.event_key == event_key,
            Picklist.owner_id == "team",
            Picklist.name == "Master Picklist",
            Picklist.is_master == True,  # noqa: E712
        )
    ).first()
    if master is None:
        master = Picklist(
            event_key=event_key, owner_id="team", name="Master Picklist", is_master=True
        )
        session.add(master)
        session.commit()
        session.refresh(master)
    return master


@router.get("/master")
def get_master(
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> dict:
    event_key = (event or get_setting(session, "current_event")).strip()
    return _dict(_ensure_master(session, event_key))


@router.get("/mine")
def get_mine(
    event: str | None = None,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> list[dict]:
    event_key = (event or get_setting(session, "current_event")).strip()
    rows = session.exec(
        select(Picklist).where(
            Picklist.owner_id == scouter.scout_id,
            Picklist.is_master == False,  # noqa: E712
        )
    ).all()
    rows = [r for r in rows if not event_key or r.event_key == event_key]
    return [_dict(r, scouter.display_name) for r in rows]


@router.get("/all")
def get_all(
    event: str | None = None,
    session: Session = Depends(get_session),
    _: Scouter = Depends(current_scouter),
) -> list[dict]:
    """Every picklist (personal + master) so the team can follow along."""
    event_key = (event or get_setting(session, "current_event")).strip()
    rows = session.exec(select(Picklist)).all()
    rows = [r for r in rows if not event_key or r.event_key == event_key]
    rows.sort(key=lambda r: (not r.is_master, r.updated_at), reverse=False)
    return [_dict(r, _owner_name(session, r.owner_id)) for r in rows]


@router.post("/finals/{division}")
def set_final(
    division: str,
    body: FinalPicklistIn,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    if not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    if division not in {"418", "436"}:
        raise HTTPException(status_code=400, detail="Final picklist must be for 418 or 436")

    event_key = (body.event_key or get_setting(session, "current_event")).strip()
    items = body.items
    source_name = ""
    if body.source_id is not None:
        source = session.get(Picklist, body.source_id)
        if not source:
            raise HTTPException(status_code=404, detail="Source picklist not found")
        if event_key and source.event_key != event_key:
            raise HTTPException(status_code=400, detail="Source picklist is for a different event")
        items = source.items
        source_name = source.name

    owner_id = f"final-{division}"
    final = session.exec(
        select(Picklist).where(
            Picklist.event_key == event_key,
            Picklist.owner_id == owner_id,
            Picklist.is_master == True,  # noqa: E712
        )
    ).first()
    if final is None:
        final = Picklist(event_key=event_key, owner_id=owner_id, is_master=True)

    final.name = body.name or f"Final Picklist {division}"
    final.items = items
    final.updated_at = datetime.now(timezone.utc)
    session.add(final)
    session.commit()
    session.refresh(final)
    emit("picklist_changed", {"id": final.id, "master": True, "final": division, "source": source_name})
    return _dict(final, f"Final {division}")


@router.post("")
def create(
    body: PicklistIn,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    event_key = (body.event_key or get_setting(session, "current_event")).strip()
    p = Picklist(
        event_key=event_key,
        owner_id=scouter.scout_id,
        name=body.name,
        is_master=False,
        items=body.items,
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    emit("picklist_changed", {"id": p.id})
    return _dict(p, scouter.display_name)


@router.put("/{pid}")
def update(
    pid: int,
    body: PicklistIn,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    p = session.get(Picklist, pid)
    if not p:
        raise HTTPException(status_code=404, detail="Picklist not found")
    # Master is collaborative (anyone may edit); personal lists are owner/admin.
    if not p.is_master and p.owner_id != scouter.scout_id and not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Not your picklist")
    p.name = body.name or p.name
    p.items = body.items
    p.updated_at = datetime.now(timezone.utc)
    session.add(p)
    session.commit()
    session.refresh(p)
    emit("picklist_changed", {"id": p.id, "master": p.is_master})
    return _dict(p, _owner_name(session, p.owner_id))


@router.delete("/{pid}")
def delete(
    pid: int,
    session: Session = Depends(get_session),
    scouter: Scouter = Depends(current_scouter),
) -> dict:
    p = session.get(Picklist, pid)
    if not p:
        raise HTTPException(status_code=404, detail="Picklist not found")
    if p.is_master:
        raise HTTPException(status_code=400, detail="Cannot delete the master list")
    if p.owner_id != scouter.scout_id and not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Not your picklist")
    session.delete(p)
    session.commit()
    emit("picklist_changed", {"deleted": pid})
    return {"ok": True}
