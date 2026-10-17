"""One-time correction of historical map taps to made shots.

Run before serving requests, after season definitions have loaded. Original
tap data and submission hashes are retained so offline replay stays idempotent.
"""
from copy import deepcopy
import logging
from uuid import uuid4

from . import repo, schema
from .cache import Store, doc_bytes
from .models import MODEL_FOR_COLLECTION
from .scoring import compute_points

MARKER = "heatmap_made_v1"
log = logging.getLogger(__name__)


def correct_report(document: dict) -> dict:
    data = document.get("data") or {}
    points = data.get("heatmap") or []
    if not any(isinstance(p, dict) and p.get("result") != "made" for p in points):
        return document
    corrected = deepcopy(document)
    payload = corrected["data"]
    payload.setdefault("heatmap_before_made_v1", deepcopy(points))
    payload["heatmap"] = [{**p, "result": "made"} for p in points if isinstance(p, dict)]
    corrected["points"] = compute_points({
        **corrected, **payload, "fouls": payload.get("foul_count", 0),
    })
    return corrected


def _commit(store, ops):
    for _, collection, key, data in ops:
        if doc_bytes(data) > schema.MAX_DOC_BYTES:
            raise ValueError(f"Corrected record exceeds size limit: {collection}/{key}")
    store._commit(ops)


def _correct_archives(store, *, rescore=False):
    from .archive import build_archive, _split_for_storage

    for manifest in store.backend.load(schema.EVENT_ARCHIVES, None).values():
        detail = deepcopy(manifest)
        # Read the durable chunks, not potentially stale process-local copies.
        for key in manifest.get("chunk_ids") or []:
            chunk = store.backend.get(schema.EVENT_ARCHIVE_CHUNKS, key)
            if chunk is None:
                raise ValueError(f"Missing archive chunk {key}")
            kind, value = chunk["kind"], chunk["data"]
            if isinstance(value, list):
                detail.setdefault(kind, []).extend(value)
            else:
                detail[kind] = value
        reports = detail.get("scouting") or []
        corrected = [correct_report(row) for row in reports]
        if not reports or (corrected == reports and not rescore):
            continue
        # Rebuild derived snapshots in an isolated store before opening the API.
        historical = Store()
        historical.backend = store.backend
        historical._docs = {key: dict(value) for key, value in store._docs.items()}
        collections = {
            schema.MATCH_SCOUTING: corrected, schema.MATCHES: detail.get("matches", []),
            schema.PIT_SCOUTING: detail.get("pit_raw", []),
            schema.PICKLISTS: detail.get("picklists_raw", []), schema.BETS: detail.get("bets", []),
            schema.EVENTS: [detail["event"]] if detail.get("event") else [],
            schema.TEAM_CACHE: detail.get("team_cache", []),
        }
        for collection, rows in collections.items():
            model = MODEL_FOR_COLLECTION[collection]
            objects = [model.from_doc("", row) for row in rows]
            historical._docs[collection] = {row.doc_id: row for row in objects}
        repo.invalidate_memo()
        original = repo.store
        try:
            repo.store = historical
            rebuilt = build_archive(manifest["event_key"], manifest.get("name"))
        finally:
            repo.store = original
            repo.invalidate_memo()
        # Preserve the archive's identity and date. New chunk IDs leave the
        # previous snapshot intact until the new manifest is committed.
        rebuilt.archived_at = MODEL_FOR_COLLECTION[schema.EVENT_ARCHIVES].from_doc("", manifest).archived_at
        summary, chunks = _split_for_storage(rebuilt)
        revision = uuid4().hex
        for chunk in chunks:
            chunk.archive_id = f"{chunk.archive_id}__{revision}"
        summary.chunk_ids = [chunk.doc_id for chunk in chunks]
        _commit(store, [("set", chunk.COLLECTION, chunk.doc_id, chunk.to_doc()) for chunk in chunks])
        _commit(store, [("set", summary.COLLECTION, summary.doc_id, summary.to_doc())])


def migrate_heatmap_shots() -> int:
    store = repo.store
    if store.setting_raw(MARKER) == "done":
        return 0
    if store.backend is None:
        raise RuntimeError("Datastore unavailable for heatmap correction")
    changed = []
    for key, raw in store.backend.load(schema.MATCH_SCOUTING, None).items():
        corrected = correct_report(raw)
        if corrected != raw:
            changed.append(("set", schema.MATCH_SCOUTING, key, corrected))
    _commit(store, changed)
    _correct_archives(store)
    store._load(schema.MATCH_SCOUTING, store.event_key or None)
    store._load(schema.EVENT_ARCHIVES, None)
    repo.invalidate_memo()
    # Commit the completion marker only after every correction succeeds.
    _commit(store, [("set", schema.APP_SETTINGS, MARKER, {"key": MARKER, "value": "done"})])
    store._load(schema.APP_SETTINGS, None)
    log.info("Corrected heatmap shots in %s scouting reports", len(changed))
    return len(changed)


def migrate_epa_scores() -> int:
    """Persist existing scores once; cached read models stay current thereafter."""
    from .epa_scoring import rescore_reports
    from .models import ScoutEntry, MatchRecord, TeamCache
    marker = "heatmap_epa_v2"
    store = repo.store
    if store.setting_raw(marker) == "done":
        return 0
    raw = store.backend.load(schema.MATCH_SCOUTING, None)
    rows = [ScoutEntry.from_doc(key, doc) for key, doc in raw.items()]
    matches = [MatchRecord.from_doc(key, doc) for key, doc in
               store.backend.load(schema.MATCHES, None).items()]
    teams = [TeamCache.from_doc(key, doc) for key, doc in
             store.backend.load(schema.TEAM_CACHE, None).items()]
    rescored = rescore_reports(rows, matches, teams)
    changes = [("set", schema.MATCH_SCOUTING, key, {**doc, "points": row.points})
               for (key, doc), row in zip(raw.items(), rescored)
               if doc.get("points") != row.points]
    _commit(store, changes)
    _correct_archives(store, rescore=True)
    store._load(schema.MATCH_SCOUTING, store.event_key or None)
    store._load(schema.EVENT_ARCHIVES, None)
    repo.invalidate_memo()
    _commit(store, [("set", schema.APP_SETTINGS, marker, {"key": marker, "value": "done"})])
    store._load(schema.APP_SETTINGS, None)
    return len(changes)
