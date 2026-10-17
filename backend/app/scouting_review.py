"""Append-only corrections for immutable scouting submissions."""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from .models import ScoutEntry


IDENTITY_FIELDS = {
    "event_key", "match_number", "comp_level", "team_number", "alliance",
    "station", "scout_id", "no_show", "notes", "actions", "responses",
}


def audit_state(audits: list[Any]) -> dict[str, dict[str, Any]]:
    """Fold immutable audit rows into the current review state per report."""
    states: dict[str, dict[str, Any]] = {}
    ordered = sorted(audits, key=lambda row: (str(row.data.get("created_at", "")), row.id))
    for row in ordered:
        data = row.data
        report_id = str(data.get("report_id") or "")
        if not report_id:
            continue
        state = states.setdefault(report_id, {"flagged": False, "voided": False, "patch": {}, "revision": 0, "audit": []})
        action = data.get("action")
        if action == "flag": state["flagged"] = True
        elif action == "resolve_flag": state["flagged"] = False
        elif action == "void": state["voided"] = True
        elif action == "restore": state["voided"] = False
        elif action == "edit": state["patch"].update(data.get("patch") or {})
        state["revision"] += 1
        state["audit"].append(data)
    return states


def apply_patch(entry: ScoutEntry, patch: dict[str, Any]) -> ScoutEntry:
    out = deepcopy(entry)
    for key, value in patch.items():
        if key in IDENTITY_FIELDS:
            setattr(out, key, value)
        else:
            out.data[key] = value
    return out


def effective_entries(entries: list[ScoutEntry], audits: list[Any], *, include_voided: bool = False) -> list[ScoutEntry]:
    states = audit_state(audits)
    out: list[ScoutEntry] = []
    for original in entries:
        state = states.get(original.submission_id, {})
        if state.get("voided") and not include_voided:
            continue
        out.append(apply_patch(original, state.get("patch") or {}))
    return out
