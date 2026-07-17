"""Picklists — personal lists plus a collaborative master list.

The stored shape follows the schema design: an ordered ``items`` array of
``{rank, team_num, tier, comments}``.  The API speaks the frontend contract
(``{team, tier, note}`` in list order); ranks are derived server-side so the
contiguous-rank invariant always holds.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from pymongo.database import Database

from ..auth import current_scouter
from ..database import database_dependency
from ..models import PicklistDocument, PicklistItem
from ..realtime import emit
from ..repositories import HazeHubRepository, RepositoryError
from ..store import get_setting
from ..views import ScouterView, scouter_names

router = APIRouter(prefix="/api/picklists", tags=["picklists"])

VALID_TIERS = {"first", "second", "third", "dnp"}


def items_to_api(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(items or [], key=lambda it: it.get("rank") or 0)
    return [
        {
            "team": it.get("team_num"),
            "tier": it.get("tier") or "second",
            "note": it.get("comments") or "",
        }
        for it in ordered
    ]


def items_from_api(items: list[dict[str, Any]]) -> list[PicklistItem]:
    out: list[PicklistItem] = []
    seen: set[int] = set()
    for raw in items or []:
        try:
            team = int(raw.get("team") or raw.get("team_num") or 0)
        except (TypeError, ValueError):
            continue
        if team <= 0 or team in seen:
            continue
        seen.add(team)
        tier = raw.get("tier")
        note = raw.get("note") or raw.get("comments") or None
        out.append(
            PicklistItem(
                rank=len(out) + 1,
                team_num=team,
                tier=tier if tier in VALID_TIERS else "second",
                comments=note,
            )
        )
    return out


def picklist_dict(doc: dict[str, Any], owner_name: str = "") -> dict:
    return {
        "id": str(doc["_id"]),
        "event_key": doc.get("event_key"),
        "owner_id": doc.get("owner_id"),
        "owner_name": owner_name or doc.get("owner_id"),
        "name": doc.get("picklist_name"),
        "is_master": bool(doc.get("is_master", False)),
        "items": items_to_api(doc.get("items") or []),
        "updated_at": doc["updated_at"].isoformat(),
    }


class PicklistIn(BaseModel):
    name: str = "My Picklist"
    event_key: Optional[str] = None
    items: list[dict[str, Any]] = Field(default_factory=list)
    is_master: bool = False


class FinalPicklistIn(BaseModel):
    source_id: Optional[str] = None
    name: Optional[str] = None
    event_key: Optional[str] = None
    items: list[dict[str, Any]] = Field(default_factory=list)


def _resolve_event(db: Database, event_key: str | None) -> str:
    event = (event_key or get_setting(db, "current_event")).strip()
    if not event:
        raise HTTPException(status_code=400, detail="No event configured yet")
    return event


def _save(db: Database, document: PicklistDocument) -> dict[str, Any]:
    try:
        return HazeHubRepository(db).save_picklist(document)
    except RepositoryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _ensure_master(db: Database, event_key: str) -> dict[str, Any]:
    master = db.picklists.find_one(
        {"event_key": event_key, "owner_id": "team", "is_master": True}
    )
    if master is not None:
        return master
    return _save(
        db,
        PicklistDocument(
            event_key=event_key,
            owner_id="team",
            picklist_name="Master Picklist",
            is_master=True,
        ),
    )


@router.get("/master")
def get_master(
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> dict:
    event_key = _resolve_event(db, event)
    return picklist_dict(_ensure_master(db, event_key), "Team")


@router.get("/mine")
def get_mine(
    event: str | None = None,
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> list[dict]:
    event_key = (event or get_setting(db, "current_event")).strip()
    query: dict[str, Any] = {"owner_id": scouter.scout_id, "is_master": False}
    if event_key:
        query["event_key"] = event_key
    rows = list(db.picklists.find(query).sort("updated_at", -1))
    return [picklist_dict(r, scouter.display_name) for r in rows]


@router.get("/all")
def get_all(
    event: str | None = None,
    db: Database = Depends(database_dependency),
    _: ScouterView = Depends(current_scouter),
) -> list[dict]:
    """Every picklist (personal + master) so the team can follow along."""
    event_key = (event or get_setting(db, "current_event")).strip()
    query: dict[str, Any] = {"event_key": event_key} if event_key else {}
    rows = list(db.picklists.find(query))
    rows.sort(key=lambda r: (not r.get("is_master"), r.get("updated_at")))
    names = scouter_names(db, (r.get("owner_id") or "" for r in rows))
    return [
        picklist_dict(r, names.get(r.get("owner_id"), r.get("owner_id"))) for r in rows
    ]


@router.post("/finals/{division}")
def set_final(
    division: str,
    body: FinalPicklistIn,
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    if not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    if division not in {"418", "436"}:
        raise HTTPException(status_code=400, detail="Final picklist must be for 418 or 436")

    event_key = _resolve_event(db, body.event_key)
    items = items_from_api(body.items)
    source_name = ""
    if body.source_id is not None:
        source = db.picklists.find_one({"_id": body.source_id})
        if not source:
            raise HTTPException(status_code=404, detail="Source picklist not found")
        if event_key and source.get("event_key") != event_key:
            raise HTTPException(status_code=400, detail="Source picklist is for a different event")
        items = items_from_api(items_to_api(source.get("items") or []))
        source_name = source.get("picklist_name") or ""

    owner_id = f"final-{division}"
    existing = db.picklists.find_one(
        {"event_key": event_key, "owner_id": owner_id, "is_master": True}
    )
    document = PicklistDocument(
        _id=str(existing["_id"]) if existing else None,
        event_key=event_key,
        owner_id=owner_id,
        picklist_name=body.name or f"Final Picklist {division}",
        is_master=True,
        items=items,
    )
    stored = _save(db, document)
    emit(
        db,
        "picklist_changed",
        {"id": str(stored["_id"]), "master": True, "final": division, "source": source_name},
    )
    return picklist_dict(stored, f"Final {division}")


@router.post("")
def create(
    body: PicklistIn,
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    event_key = _resolve_event(db, body.event_key)
    document = PicklistDocument(
        event_key=event_key,
        owner_id=scouter.scout_id,
        picklist_name=body.name or "My Picklist",
        is_master=False,
        items=items_from_api(body.items),
    )
    stored = _save(db, document)
    emit(db, "picklist_changed", {"id": str(stored["_id"])})
    return picklist_dict(stored, scouter.display_name)


@router.put("/{pid}")
def update(
    pid: str,
    body: PicklistIn,
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    existing = db.picklists.find_one({"_id": pid})
    if not existing:
        raise HTTPException(status_code=404, detail="Picklist not found")
    # Master is collaborative (anyone may edit); personal lists are owner/admin.
    is_master = bool(existing.get("is_master"))
    if not is_master and existing.get("owner_id") != scouter.scout_id and not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Not your picklist")

    document = PicklistDocument(
        _id=pid,
        event_key=existing.get("event_key"),
        owner_id=existing.get("owner_id"),
        picklist_name=body.name or existing.get("picklist_name"),
        is_master=is_master,
        items=items_from_api(body.items),
    )
    stored = _save(db, document)
    names = scouter_names(db, [stored.get("owner_id") or ""])
    emit(db, "picklist_changed", {"id": pid, "master": is_master})
    return picklist_dict(stored, names.get(stored.get("owner_id"), ""))


@router.delete("/{pid}")
def delete(
    pid: str,
    db: Database = Depends(database_dependency),
    scouter: ScouterView = Depends(current_scouter),
) -> dict:
    existing = db.picklists.find_one({"_id": pid})
    if not existing:
        raise HTTPException(status_code=404, detail="Picklist not found")
    if existing.get("is_master") and existing.get("owner_id") == "team":
        raise HTTPException(status_code=400, detail="Cannot delete the master list")
    if existing.get("owner_id") != scouter.scout_id and not scouter.is_admin:
        raise HTTPException(status_code=403, detail="Not your picklist")
    db.picklists.delete_one({"_id": pid})
    emit(db, "picklist_changed", {"deleted": pid})
    return {"ok": True}
