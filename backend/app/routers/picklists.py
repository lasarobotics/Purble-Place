"""Picklist API. Authentication is reused unchanged; privileges are enforced here."""
from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from ..auth import current_scouter, require_admin
from ..models import Scouter
from .. import picklist_service as svc

router = APIRouter(prefix="/api/picklists", tags=["picklists"])

class PicklistIn(BaseModel):
    event_key: str | None = None
    name: str | None = None
    pick_round: int = 1
    items: list[dict[str, Any]] = Field(default_factory=list)
    version: int | None = None
    request_id: str = ""
    robot_number: int = 418
    robot_name: str = "Purple Haze"
    owner_name: str | None = None

class DraftIn(PicklistIn):
    id: int

class SubmitIn(PicklistIn):
    robot_number: int

class DraftBatchIn(BaseModel):
    event_key: str
    drafts: list[DraftIn]

class WorkspaceIn(BaseModel):
    event_key: str | None = None
    name: str
    robot_number: int = 418
    robot_name: str = "Purple Haze"
    first_items: list[dict[str, Any]] = Field(default_factory=list)
    second_items: list[dict[str, Any]] = Field(default_factory=list)

class ActionIn(BaseModel):
    event_key: str | None = None
    version: int
    action: str
    data: dict[str, Any] = Field(default_factory=dict)

class CompareIn(BaseModel):
    event_key: str
    ids: list[int] = Field(default_factory=list)
    pick_round: int
    sort: str = "average"

class DeleteIn(BaseModel):
    ids: list[str | int] = Field(default_factory=list)
    event_key: str | None = None
    confirmation: str = ""
    all_events: bool = False
    confirm_all: bool = False

@router.get("/mine")
def mine(event: str | None = None, user: Scouter = Depends(current_scouter)):
    return svc.mine(svc.event_key(event), user)

@router.get("/submissions")
def submissions(event: str | None = None, search: str = "", pick_round: int = 0, user: Scouter = Depends(current_scouter)):
    return svc.submissions(svc.event_key(event), user, search, pick_round)

@router.post("/compare")
def compare(body: CompareIn, user: Scouter = Depends(require_admin)):
    return svc.compare(svc.event_key(body.event_key), body.ids, body.pick_round, body.sort)

@router.get("/meeting")
def meeting(event: str | None = None, client: str | None = None, user: Scouter = Depends(current_scouter)):
    return svc.public_state(svc.event_key(event), client)


@router.get("/final-workspace")
def final_workspace(event: str | None = None, user: Scouter = Depends(require_admin)):
    state = svc.public_state(svc.event_key(event))
    return {k: state[k] for k in ("event_key", "version", "robots", "boards", "published", "locked") if k in state}


@router.post("/final-workspace")
def final_action(body: ActionIn, user: Scouter = Depends(require_admin)):
    if body.action not in ("edit", "edit_boards", "import", "add_robot", "rename_robot", "remove_robot", "publish", "unpublish", "undo", "redo"):
        raise HTTPException(422, "Unsupported final picklist action")
    svc.action(svc.event_key(body.event_key), user, body, final_mode=True)
    return final_workspace(body.event_key, user)

@router.post("/meeting")
def meeting_action(body: ActionIn, user: Scouter = Depends(require_admin)):
    return svc.action(svc.event_key(body.event_key), user, body)

@router.get("/history")
def history(event: str | None = None, offset: int = 0, user: Scouter = Depends(require_admin)):
    rows = svc.history(svc.event_key(event))
    start = max(0, offset)
    return {"entries": rows[start:start + 50], "total": len(rows)}

@router.get("/finals")
def finals(event: str | None = None, user: Scouter = Depends(current_scouter)):
    state = svc.public_state(svc.event_key(event))
    published = state["published"]
    return [dict(b, published_at=published["published_at"]) for b in published["boards"]] if published else []

@router.get("/master")
def master(event: str | None = None, user: Scouter = Depends(current_scouter)):
    return svc.public_state(svc.event_key(event))["boards"]

@router.get("/all")
def all_lists(event: str | None = None, all_events: bool = False, user: Scouter = Depends(require_admin)):
    return svc.inventory(None if all_events else svc.event_key(event))

@router.post("/delete")
def delete_selected(body: DeleteIn, user: Scouter = Depends(require_admin)):
    return svc.delete_records(body.ids, None if body.all_events else svc.event_key(body.event_key))

@router.post("/reset")
def reset(body: DeleteIn, user: Scouter = Depends(require_admin)):
    return svc.reset_records(svc.event_key(body.event_key), body.confirmation, body.all_events, body.confirm_all)

@router.post("")
def create(body: PicklistIn, user: Scouter = Depends(current_scouter)):
    return svc.save_draft(svc.event_key(body.event_key), user, body)

@router.post("/workspace")
def create_workspace(body: WorkspaceIn, user: Scouter = Depends(current_scouter)):
    return svc.create_workspace(svc.event_key(body.event_key), user, body)

@router.put("/{pid}")
def update(pid: int, body: PicklistIn, user: Scouter = Depends(current_scouter)):
    return svc.save_draft(svc.event_key(body.event_key), user, body, pid)

@router.delete("/{pid}")
def delete_draft(pid: int, event: str | None = None, user: Scouter = Depends(current_scouter)):
    return svc.delete_draft(svc.event_key(event), user, pid)

@router.delete("/workspace/{workspace_id}")
def delete_workspace(workspace_id: str, event: str | None = None, user: Scouter = Depends(current_scouter)):
    return svc.delete_workspace(svc.event_key(event), user, workspace_id)

@router.post("/drafts")
def save_drafts(body: DraftBatchIn, user: Scouter = Depends(current_scouter)):
    return svc.save_drafts(svc.event_key(body.event_key), user, body.drafts)

@router.post("/{pid}/submit")
def submit(pid: int, body: SubmitIn, user: Scouter = Depends(current_scouter)):
    return svc.submit(svc.event_key(body.event_key), user, pid, body)

# Old collaborative final-write/delete routes intentionally have no handler.
# Official results are published atomically through the Admin-only meeting API.
