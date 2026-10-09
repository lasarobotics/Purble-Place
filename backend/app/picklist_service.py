"""Event-isolated picklists. Durable-first writes; one writer, as in render.yaml.

Submissions and published/history snapshots are immutable documents. Meeting
boards contain copies, never references to mutable personal lists. Only three
events (and at most 32 MiB) are cached; history is fetched only on demand.
"""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from threading import RLock
from time import monotonic
from uuid import uuid4

from fastapi import HTTPException
from . import repo, schema
from .cache import doc_bytes
from .models import Picklist
from .realtime import emit

RECORDS = schema.PICKLIST_RECORDS
STATES = schema.PICKLIST_WORKSPACES
HISTORY = schema.PICKLIST_HISTORY
_lock = RLock()
_cache = OrderedDict()
_presence = {}


def now():
    return datetime.now(timezone.utc).isoformat()


def admin(user):
    return user.scout_id == "Admin" and user.role == "admin"


def event_key(event=None):
    key = repo.resolve_event(event)
    if not key:
        raise HTTPException(400, "Select a competition first")
    try:
        schema.safe_doc_id(key)
    except ValueError as exc:
        raise HTTPException(400, "Invalid competition ID") from exc
    return key


def commit(ops):
    if not repo.store.backend:
        raise HTTPException(503, "Picklist storage is unavailable; your changes were not saved")
    if len(ops) > 450 or sum(doc_bytes(op[3] or {}) for op in ops) > schema.MAX_BATCH_BYTES:
        raise HTTPException(413, "Select fewer lists per deletion (maximum 400). Nothing was changed.")
    if any(doc_bytes(op[3] or {}) > schema.MAX_DOC_BYTES for op in ops):
        raise HTTPException(413, "Picklist is too large; shorten notes or reduce teams")
    try:
        # One Firestore batch is atomic. Never chunk a user-visible mutation.
        repo.store.backend.commit(ops)
    except Exception as exc:
        raise HTTPException(503, "Could not save picklists. Retry when connected.") from exc


def put(collection, key, data):
    return ("set", collection, str(key), data)


def remember(key, state, records):
    _cache[key] = (deepcopy(state), deepcopy(records))
    _cache.move_to_end(key)
    while len(_cache) > 3 or sum(doc_bytes({"s": s, "r": r}) for s, r in _cache.values()) > 32 * 1024 * 1024:
        _cache.popitem(last=False)


def board(event, round_, items=None):
    return dict(id=-round_, event_key=event, owner_id="team", owner_name="Meeting", owner_role="master",
                priority=0, is_master=True, pick_round=round_, name=f"Final {'First' if round_ == 1 else 'Second'} Pick",
                items=deepcopy(items or []), updated_at=now())


def fresh(event, generation=None):
    return dict(event_key=event, generation=generation or uuid4().hex, version=0, status="not_started",
                locked=False, view="both", selected_team=None, boards=[board(event, 1), board(event, 2)],
                notes={}, team_statuses={}, published=None, undo=[], redo=[], updated_at=now())


def workspace(event):
    with _lock:
        return _workspace(event)


def _workspace(event):
    if event in _cache:
        _cache.move_to_end(event)
        return deepcopy(_cache[event])
    backend = repo.store.backend
    if not backend:
        raise HTTPException(503, "Picklist storage is unavailable")
    try:
        state = backend.get(STATES, event)
        records = backend.load(RECORDS, event)
    except Exception as exc:
        raise HTTPException(503, "Could not load picklists") from exc
    if state is None:
        state = fresh(event)
        # Additive migration: keep every original document untouched. Old master
        # boards seed the meeting; personal lists become drafts, not submissions.
        originals = backend.load(schema.PICKLISTS, event)
        ops = []
        for key, doc in originals.items():
            p = Picklist.from_doc(key, doc)
            if p.owner_id == "team":
                state["boards"][p.pick_round - 1] = board(event, p.pick_round, p.items)
                continue
            owner = repo.scouter(p.owner_id)
            row = dict(id=p.id, event_key=event, owner_id=p.owner_id,
                       owner_name=(owner.display_name or owner.scout_id) if owner else p.owner_id,
                       owner_role=owner.role if owner else "scouter", priority=2, name=p.name,
                       is_master=p.is_master, pick_round=p.pick_round, items=p.items,
                       updated_at=p.updated_at.isoformat(), created_at=p.created_at.isoformat(),
                       status="Archived" if p.is_master else "Draft", version=1, generation=state["generation"])
            records[str(p.id)] = row
            ops.append(put(RECORDS, p.id, row))
        # Migration may be large: immutable copies are safe to stage before the
        # workspace marker. A crash retries the same IDs without losing sources.
        for start in range(0, len(ops), 100):
            commit(ops[start:start + 100])
        commit([put(STATES, event, state)])
    records = {k: v for k, v in records.items() if v.get("generation") == state["generation"]}
    remember(event, state, records)
    return deepcopy((state, records))


def changed(event, state, records):
    remember(event, state, records)
    emit("picklist_changed", {"event": event, "version": state["version"]})


def validate_items(items, nonempty=False):
    if len(items) > 500:
        raise HTTPException(400, "A list may contain at most 500 teams")
    try:
        nums = [int(i.get("team", i.get("team_num", 0))) for i in items]
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid team number")
    if any(n <= 0 for n in nums) or len(set(nums)) != len(nums):
        raise HTTPException(400, "Teams must be positive and cannot appear twice")
    if nonempty and not nums:
        raise HTTPException(400, "Add at least one team before submitting")
    return Picklist.normalize_items(items)


def validate_name(name):
    name = str(name or "").strip()
    if not name or len(name) > 100 or any(ord(c) < 32 for c in name):
        raise HTTPException(400, "Enter a list name of 1 to 100 readable characters")
    return name


def check_version(actual, expected):
    if expected != actual:
        raise HTTPException(409, "This list changed in another session. Reload the latest version before saving.")


def new_draft(event, user, round_, name=None, items=None):
    if round_ not in (1, 2):
        raise HTTPException(400, "Choose First Pick or Second Pick")
    return dict(id=int(uuid4().hex[:13], 16), event_key=event, owner_id=user.scout_id,
                owner_name=user.display_name or user.scout_id, owner_role=user.role, priority=2,
                is_master=False, pick_round=round_, name=validate_name(name or f"{user.display_name or user.scout_id} {'First' if round_ == 1 else 'Second'} Pick"),
                items=validate_items(items or []), status="Draft", version=1, created_at=now(), updated_at=now())


def mine(event, user):
    with _lock:
        state, records = workspace(event)
        rows = [r for r in records.values() if r["owner_id"] == user.scout_id and r["status"] == "Draft"]
        ops = []
        for round_ in (1, 2):
            if not any(r["pick_round"] == round_ for r in rows):
                row = new_draft(event, user, round_)
                row["generation"] = state["generation"]
                records[str(row["id"])] = row
                rows.append(row)
                ops.append(put(RECORDS, row["id"], row))
        if ops:
            commit(ops)
            changed(event, state, records)
        return rows


def save_draft(event, user, body, pid=None):
    with _lock:
        state, records = workspace(event)
        if pid is None:
            row = new_draft(event, user, body.pick_round, body.name, body.items)
            row["generation"] = state["generation"]
        else:
            row = records.get(str(pid))
            if not row:
                raise HTTPException(404, "Picklist not found in this event")
            if row["owner_id"] != user.scout_id or row["status"] != "Draft":
                raise HTTPException(403, "Only your own drafts can be edited")
            check_version(row["version"], body.version)
            row.update(name=validate_name(body.name or row["name"]), items=validate_items(body.items),
                       version=row["version"] + 1, updated_at=now())
        commit([put(RECORDS, row["id"], row)])
        records[str(row["id"])] = row
        changed(event, state, records)
        return row


def save_drafts(event, user, drafts):
    with _lock:
        state, records = workspace(event)
        updated = []
        if not drafts or len(drafts) > 100:
            raise HTTPException(400, "Choose between 1 and 100 drafts")
        for draft in drafts:
            row = records.get(str(draft.id))
            if not row or row["owner_id"] != user.scout_id or row["status"] != "Draft":
                raise HTTPException(403, "Only your own drafts in this event can be edited")
            check_version(row["version"], draft.version)
            row.update(name=validate_name(draft.name), items=validate_items(draft.items),
                       version=row["version"] + 1, updated_at=now())
            updated.append(row)
        commit([put(RECORDS, row["id"], row) for row in updated])
        changed(event, state, records)
        return updated


def submit(event, user, pid, body):
    with _lock:
        state, records = workspace(event)
        token = body.request_id
        if not token or len(token) > 100:
            raise HTTPException(400, "A submission request ID is required")
        key = str(int(sha256(f"{event}:{state['generation']}:{user.scout_id}:{token}".encode()).hexdigest()[:13], 16))
        previous = records.get(key)
        if previous:
            return previous
        if state["locked"]:
            raise HTTPException(423, "Submissions are locked for this event")
        source = records.get(str(pid))
        if not source or source["owner_id"] != user.scout_id or source["status"] != "Draft":
            raise HTTPException(403, "Submit one of your own drafts")
        check_version(source["version"], body.version)
        if body.pick_round != source["pick_round"]:
            raise HTTPException(400, "The selected round does not match the draft")
        prior = [r for r in records.values() if r.get("source_id") == pid and r["status"] == "Submitted"]
        row = dict(source, id=int(key), source_id=pid, name=validate_name(body.name),
                   items=validate_items(source["items"], True), status="Submitted", version=len(prior) + 1,
                   owner_name=user.display_name or user.scout_id, created_at=now(), updated_at=now())
        commit([put(RECORDS, key, row)])
        records[key] = row
        changed(event, state, records)
        return row


def submissions(event, user, search="", round_=0):
    with _lock:
        _, records = workspace(event)
        rows = [r for r in records.values() if r["status"] == "Submitted" and (admin(user) or r["owner_id"] == user.scout_id)]
        latest = {}
        for row in rows:
            latest[row["source_id"]] = max(latest.get(row["source_id"], 0), row["version"])
        return [dict(r, latest=r["version"] == latest[r["source_id"]]) for r in sorted(rows, key=lambda r: r["updated_at"], reverse=True)
                if (not round_ or r["pick_round"] == round_) and search.casefold() in (r["name"] + " " + r["owner_name"]).casefold()]


def compare(event, ids, round_, sort):
    from .analytics import team_summary
    if round_ not in (1, 2) or len(ids) > 200:
        raise HTTPException(400, "Compare up to 200 submissions from one pick round")
    with _lock:
        _, records = workspace(event)
        lists = [records.get(str(key)) for key in dict.fromkeys(ids)]
        if any(not row or row["status"] != "Submitted" or row["pick_round"] != round_ for row in lists):
            raise HTTPException(400, "Choose submitted lists from the same event and round")
        rankings = {}
        for row in lists:
            for index, item in enumerate(row["items"]):
                rankings.setdefault(item["team"], []).append({"rank": index + 1, "list": row["name"], "id": row["id"]})
        result = []
        for team, values in rankings.items():
            ranks = [v["rank"] for v in values]
            summary = team_summary(event, team) if sort.startswith("metric:") else {}
            metric = summary.get(sort.removeprefix("metric:"))
            result.append(dict(team=team, values=values, frequency=len(ranks), average=sum(ranks) / len(ranks),
                               best=min(ranks), worst=max(ranks), spread=max(ranks) - min(ranks), metric=metric))
        if sort == "team":
            result.sort(key=lambda r: r["team"])
        elif sort == "frequency":
            result.sort(key=lambda r: (-r["frequency"], r["average"], r["team"]))
        elif sort in ("metric:avg_points", "metric:operational_rate"):
            result.sort(key=lambda r: (r["metric"] is None, -(r["metric"] or 0), r["team"]))
        else:
            result.sort(key=lambda r: (r["average"], r["team"]))
        return {"teams": result, "list_count": len(lists), "pick_round": round_}


def public_state(event, client=None):
    with _lock:
        state, _ = workspace(event)
        cutoff = monotonic() - 45
        for key in list(_presence):
            if _presence[key] < cutoff:
                del _presence[key]
        if client and len(_presence) < 1000:
            _presence[(event, client[:100])] = monotonic()
        result = {k: v for k, v in state.items() if k not in ("undo", "redo", "generation")}
        result.update(viewers=sum(k[0] == event for k in _presence), can_undo=bool(state["undo"]), can_redo=bool(state["redo"]))
        return result


def snapshot(state):
    return deepcopy({k: state[k] for k in ("boards", "notes", "team_statuses")})


def history(event):
    with _lock:
        state, _ = workspace(event)
        rows = repo.store.backend.load(HISTORY, event)
        return sorted([r for r in rows.values() if r["generation"] == state["generation"]], key=lambda r: r["created_at"], reverse=True)


def action(event, user, body):
    with _lock:
        state, records = workspace(event)
        check_version(state["version"], body.version)
        kind, data = body.action, body.data
        meaningful = kind not in ("view", "select", "clear_temporary")
        editing = kind in ("edit", "edit_boards", "import", "restore", "undo", "redo", "team")
        if editing and state["status"] != "live":
            raise HTTPException(409, "Start or resume the meeting before editing")
        if editing and kind not in ("undo", "redo"):
            state["undo"] = (state["undo"] + [snapshot(state)])[-20:]
            state["redo"] = []
        if kind in ("start", "resume", "pause", "end"):
            allowed = {"start": ("not_started", "ended"), "resume": ("paused",), "pause": ("live",), "end": ("live", "paused")}
            if state["status"] not in allowed[kind]:
                raise HTTPException(409, "Meeting status has changed")
            state["status"] = {"start": "live", "resume": "live", "pause": "paused", "end": "ended"}[kind]
        elif kind == "reset":
            preserved = {k: state[k] for k in ("generation", "version", "published", "locked")}
            state = fresh(event)
            state.update(preserved)
        elif kind == "clear_temporary":
            state["selected_team"] = None
            for key in list(_presence):
                if key[0] == event:
                    del _presence[key]
        elif kind == "lock":
            state["locked"] = bool(data.get("locked"))
        elif kind == "view":
            if data.get("view") not in ("first", "second", "both"):
                raise HTTPException(400, "Invalid view")
            state["view"] = data["view"]
        elif kind == "select":
            state["selected_team"] = int(data["team"]) if data.get("team") else None
        elif kind == "edit_boards":
            boards = data.get("boards", {})
            if not boards or any(str(r) not in ("1", "2") for r in boards):
                raise HTTPException(400, "Choose valid working boards")
            for round_, items in boards.items():
                r = int(round_)
                state["boards"][r - 1] = board(event, r, validate_items(items))
        elif kind in ("edit", "import"):
            round_ = int(data.get("pick_round", 0))
            if round_ not in (1, 2):
                raise HTTPException(400, "Invalid pick round")
            items = data.get("items", [])
            if kind == "import":
                source = records.get(str(data.get("source_id")))
                if not source or source["status"] != "Submitted" or source["pick_round"] != round_:
                    raise HTTPException(400, "Choose a submission from this event and round")
                items = source["items"]
            state["boards"][round_ - 1] = board(event, round_, validate_items(items))
        elif kind == "restore":
            row = repo.store.backend.get(HISTORY, str(data.get("id")))
            if not row or row["event_key"] != event or row["generation"] != state["generation"]:
                raise HTTPException(404, "History entry not found")
            state.update(deepcopy(row["snapshot"]))
        elif kind in ("undo", "redo"):
            source, target = ("undo", "redo") if kind == "undo" else ("redo", "undo")
            if not state[source]:
                raise HTTPException(409, "No more changes to restore")
            state[target] = (state[target] + [snapshot(state)])[-20:]
            state.update(state[source].pop())
        elif kind == "team":
            team = str(int(data.get("team", 0)))
            if int(team) <= 0:
                raise HTTPException(400, "Invalid team")
            status = data.get("status", "Available")
            if status not in ("Available", "Already Selected", "Unavailable", "Do Not Pick"):
                raise HTTPException(400, "Invalid status")
            state["team_statuses"][team] = status
            state["notes"][team] = str(data.get("note", ""))[:5000]
        elif kind == "publish":
            if state["status"] not in ("live", "paused", "ended"):
                raise HTTPException(409, "Start the meeting before publishing")
            if not all(b["items"] for b in state["boards"]):
                raise HTTPException(400, "Both lists must contain teams before publishing")
            state["published"] = dict(boards=deepcopy(state["boards"]), published_at=now(), by=user.display_name or user.scout_id)
        elif kind == "unpublish":
            state["published"] = None
        else:
            raise HTTPException(400, "Unknown meeting action")
        state["version"] += 1
        state["updated_at"] = now()
        ops = [put(STATES, event, state)]
        if meaningful:
            entry = dict(id=uuid4().hex, event_key=event, generation=state["generation"], action=kind,
                         actor=user.display_name or user.scout_id, created_at=now(), snapshot=snapshot(state), published=state["published"])
            ops.append(put(HISTORY, entry["id"], entry))
        commit(ops)
        changed(event, state, records)
        return public_state(event)


def inventory(event=None):
    # Admin opens this on demand; never poll all events from Firestore.
    events = {event} if event else set(repo.store.backend.load(STATES, None)) | {r["event_key"] for r in repo.store.backend.load(schema.PICKLISTS, None).values()}
    result = []
    for key in sorted(events):
        state, records = workspace(key)
        result.extend(records.values())
        if state["published"]:
            result.extend(dict(b, id=f"final:{key}:{b['pick_round']}", status="Final", version=state["version"]) for b in state["published"]["boards"])
    return result


def delete_records(ids, event=None):
    with _lock:
        if not ids or len(ids) > 400:
            raise HTTPException(400, "Select between 1 and 400 lists")
        selected = [r for r in inventory(event) if str(r["id"]) in {str(i) for i in ids}]
        if len(selected) != len(set(map(str, ids))):
            raise HTTPException(409, "Selection changed; reload the list")
        work = {}
        ops = []
        for row in selected:
            key = row["event_key"]
            state, records = work.setdefault(key, workspace(key))
            if state["status"] in ("live", "paused"):
                raise HTTPException(409, f"End or reset the meeting at {key} before deleting lists")
            if row["status"] == "Final":
                remaining = [b for b in state["published"]["boards"] if b["pick_round"] != row["pick_round"]]
                state["published"] = dict(state["published"], boards=remaining) if remaining else None
                state["version"] += 1
                continue
            records.pop(str(row["id"]), None)
            ops.append(("delete", RECORDS, str(row["id"]), None))
        ops.extend(put(STATES, key, state) for key, (state, _) in work.items())
        commit(ops)
        for key, (state, records) in work.items():
            changed(key, state, records)
        return {"deleted": len(selected)}


def reset_records(event, confirmation, all_events=False, confirm_all=False):
    with _lock:
        if confirmation != "RESET PICKLISTS" or (all_events and not confirm_all):
            raise HTTPException(400, "Type RESET PICKLISTS and confirm the selected scope")
        keys = ({r["event_key"] for r in inventory()} | set(repo.store.backend.load(STATES, None)) | {event}) if all_events else {event}
        work = []
        for key in keys:
            state, _ = workspace(key)
            if state["status"] in ("live", "paused"):
                raise HTTPException(409, f"End or reset the meeting at {key} first")
            replacement = fresh(key)
            replacement["version"] = state["version"] + 1
            work.append((key, replacement))
        # Atomic generation switch: all picklist-only records disappear together,
        # regardless of record count. Original legacy data is never reimported.
        commit([put(STATES, key, state) for key, state in work])
        for key, state in work:
            changed(key, state, {})
        # The generation switch above is the transaction boundary. Physical
        # cleanup can be retried safely; retired records are never visible again.
        cleanup_pending = False
        for key, state in work:
            try:
                for collection in (RECORDS, HISTORY, schema.PICKLISTS):
                    old = repo.store.backend.load(collection, key)
                    ops = [("delete", collection, doc_id, None) for doc_id, doc in old.items()
                           if doc.get("generation") != state["generation"]]
                    for start in range(0, len(ops), 400):
                        commit(ops[start:start + 400])
            except Exception:
                cleanup_pending = True
        return {"reset_events": sorted(keys), "cleanup_pending": cleanup_pending}
