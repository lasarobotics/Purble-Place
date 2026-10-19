"""The read cache and write path that keep HazeHub inside Firestore's quotas.

The problem
-----------
About 60 people use HazeHub for a ~12 hour competition day. Every device
polls for live updates and every admin screen re-reads the whole event. If
those requests reached Firestore, a single day would cost on the order of
10^7 document reads: three orders of magnitude past the 50,000/day free
allowance, and expensive even on Blaze.

The shape of the data is what makes this avoidable: one event is a few
thousand small documents, and this API is the only writer. So the entire
working set fits in memory, and RAM: not Firestore: can serve reads.

The design
----------
* **Load once, then serve from RAM.** At boot every hot collection is
  streamed into memory (a few thousand reads, once). After that, HTTP GETs
  never touch Firestore.
* **Write through.** A mutation is applied to the in-memory copy *and* sent
  to Firestore. The cache stays authoritative because this service is the
  only writer, so it can never drift.
* **Dirty checking.** ``write()`` compares against the cached document and
  skips Firestore entirely when nothing changed. This is what makes the TBA
  schedule sync cheap: re-syncing 120 matches writes only the handful whose
  scores actually moved, instead of 120 documents every time an admin
  advances the match.
* **Coalescing.** Counters that would otherwise be written per request
  (``matches_scouted``, presence) are debounced, which also keeps every
  document under Firestore's ~1 write/second sustained ceiling.
* **Batching.** Bulk paths chunk at 450 operations, below the hard 500 per
  commit.

Running more than one instance
------------------------------
Write-through caching assumes a single writer. The Cloud Run service is
therefore deployed with ``--max-instances=1`` (see ``deploy/firebase.ps1``).
If you ever need more than one instance: or you want edits made in the
Firebase console to appear live: set ``HAZEHUB_FIRESTORE_LISTEN=1`` to
attach snapshot listeners instead. That is correct under concurrency but
costs one document read per change, so it is off by default.

Local development
-----------------
With no Firebase project configured and no emulator running, the cache falls
back to :class:`LocalBackend`, a JSON file under ``backend/data/``. It exists
so ``npm run dev`` works on a plane; it is never used once
``FIREBASE_PROJECT_ID`` or ``FIRESTORE_EMULATOR_HOST`` is set.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from . import firestore_db as fs
from . import schema
from .models import MODEL_FOR_COLLECTION

log = logging.getLogger("hazehub.cache")

LISTEN = os.getenv("HAZEHUB_FIRESTORE_LISTEN", "0") == "1"
#: How long coalesced writes may sit in memory before being flushed.
FLUSH_INTERVAL_S = float(os.getenv("HAZEHUB_FLUSH_INTERVAL", "2.0"))


class WriteTooLarge(Exception):
    """A document exceeded Firestore's per-document size limit."""


class StoreUnavailable(Exception):
    """Firestore is configured but unreachable."""


def doc_bytes(data: dict[str, Any]) -> int:
    """Approximate the stored size of a document.

    Firestore's exact accounting adds per-field name overhead; a compact JSON
    encoding is a close enough proxy given we refuse at 900 KiB against a
    1 MiB hard limit.
    """
    return len(json.dumps(data, default=str, separators=(",", ":")).encode("utf-8"))


# --------------------------------------------------------------------------- #
# Backends                                                                     #
# --------------------------------------------------------------------------- #
class FirestoreBackend:
    """Talks to Cloud Firestore and accounts for every document operation."""

    name = "firestore"

    def load(self, collection: str, event_key: Optional[str]) -> dict[str, dict]:
        col = fs.collection(collection)
        query = col
        if event_key:
            query = col.where(filter=fs.field_filter("event_key", "==", event_key))
        out: dict[str, dict] = {}
        for snap in query.stream():
            out[snap.id] = snap.to_dict() or {}
        fs.count("read", max(1, len(out)))  # an empty result still bills 1 read
        return out

    def get(self, collection: str, doc_id: str) -> Optional[dict]:
        snap = fs.document(collection, doc_id).get()
        fs.count("read")
        if not snap.exists:
            return None
        return snap.to_dict() or {}

    def watch(
        self,
        collection: str,
        event_key: Optional[str],
        on_change: Callable[[str, Optional[dict]], None],
    ):
        col = fs.collection(collection)
        query = col
        if event_key:
            query = col.where(filter=fs.field_filter("event_key", "==", event_key))

        def _callback(snapshots, changes, read_time):  # noqa: ANN001
            fs.count("read", len(changes))
            for change in changes:
                if change.type.name == "REMOVED":
                    on_change(change.document.id, None)
                else:
                    on_change(change.document.id, change.document.to_dict() or {})

        return query.on_snapshot(_callback)

    def set(self, collection: str, doc_id: str, data: dict) -> None:
        fs.document(collection, doc_id).set(data)
        fs.count("write")

    def create(self, collection: str, doc_id: str, data: dict) -> bool:
        from google.api_core import exceptions as gexc

        try:
            fs.document(collection, doc_id).create(data)
            fs.count("write")
            return True
        except gexc.AlreadyExists:
            return False

    def delete(self, collection: str, doc_id: str) -> None:
        fs.document(collection, doc_id).delete()
        fs.count("delete")

    def commit(self, ops: list[tuple[str, str, str, Optional[dict]]]) -> None:
        """Commit one batch of ``(kind, collection, doc_id, data)`` tuples.

        ``Store._commit`` has already chunked this below Firestore's 500
        operations / 10 MiB per-commit limits.
        """
        client = fs.get_client()
        batch = client.batch()
        writes = deletes = 0
        for kind, collection, doc_id, data in ops:
            ref = client.collection(collection).document(doc_id)
            if kind == "delete":
                batch.delete(ref)
                deletes += 1
            else:
                batch.set(ref, data)
                writes += 1
        batch.commit()
        fs.count("write", writes)
        fs.count("delete", deletes)


class LocalBackend:
    """Development-only JSON-file store with the same surface as Firestore."""

    name = "local-file"

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, dict]] = {}
        self._mtime: float = -1.0
        self._reread()

    def _reread(self) -> None:
        """Re-read the file if another process has written it.

        Firestore has snapshot listeners; this file does not, so without this
        check a second process (``python -m app.demo_data``, a hand edit, a
        second server) would be silently clobbered the next time this one
        wrote: every write persists the whole document set, so a stale
        in-memory copy overwrites everything it did not know about. That is
        how the current event pointer used to drift back to a stale value and
        take the event's scouting out of the cache with it.

        Callers hold ``self._lock``, except the constructor where nothing else
        can be running yet.
        """
        try:
            mtime = self.path.stat().st_mtime
        except OSError:
            return
        if mtime == self._mtime:
            return
        try:
            self._data = json.loads(self.path.read_text(encoding="utf-8"))
            self._mtime = mtime
        except Exception:  # noqa: BLE001 - a corrupt dev file just resets
            self._data = {}
            self._mtime = mtime

    def _persist(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self._data, default=str, indent=0), encoding="utf-8"
        )
        tmp.replace(self.path)
        try:
            self._mtime = self.path.stat().st_mtime
        except OSError:
            self._mtime = -1.0

    def load(self, collection: str, event_key: Optional[str]) -> dict[str, dict]:
        with self._lock:
            self._reread()
            docs = dict(self._data.get(collection, {}))
        if event_key:
            docs = {k: v for k, v in docs.items() if v.get("event_key") == event_key}
        return docs

    def get(self, collection: str, doc_id: str) -> Optional[dict]:
        with self._lock:
            self._reread()
            doc = self._data.get(collection, {}).get(doc_id)
        return dict(doc) if isinstance(doc, dict) else None

    def watch(self, collection, event_key, on_change):  # noqa: ANN001, ARG002
        return None  # single process: the cache is already the source of truth

    def set(self, collection: str, doc_id: str, data: dict) -> None:
        with self._lock:
            self._reread()
            self._data.setdefault(collection, {})[doc_id] = json.loads(
                json.dumps(data, default=str)
            )
            self._persist()

    def create(self, collection: str, doc_id: str, data: dict) -> bool:
        with self._lock:
            self._reread()
            bucket = self._data.setdefault(collection, {})
            if doc_id in bucket:
                return False
            bucket[doc_id] = json.loads(json.dumps(data, default=str))
            self._persist()
            return True

    def delete(self, collection: str, doc_id: str) -> None:
        with self._lock:
            self._reread()
            self._data.get(collection, {}).pop(doc_id, None)
            self._persist()

    def commit(self, ops: list[tuple[str, str, str, Optional[dict]]]) -> None:
        from copy import deepcopy
        with self._lock:
            self._reread()
            previous = self._data
            self._data = deepcopy(previous)
            try:
                for kind, collection, doc_id, data in ops:
                    if kind == "delete":
                        self._data.get(collection, {}).pop(doc_id, None)
                    else:
                        self._data.setdefault(collection, {})[doc_id] = json.loads(
                            json.dumps(data, default=str)
                        )
                self._persist()
            except Exception:
                self._data = previous
                raise



def _chunks(
    ops: list[tuple[str, str, str, Optional[dict]]], max_ops: int, max_bytes: int
) -> Iterable[list[tuple[str, str, str, Optional[dict]]]]:
    chunk: list[tuple[str, str, str, Optional[dict]]] = []
    size = 0
    for op in ops:
        op_size = doc_bytes(op[3]) if op[3] else 64
        if chunk and (len(chunk) >= max_ops or size + op_size > max_bytes):
            yield chunk
            chunk, size = [], 0
        chunk.append(op)
        size += op_size
    if chunk:
        yield chunk


# --------------------------------------------------------------------------- #
# The cache                                                                    #
# --------------------------------------------------------------------------- #
class Store:
    """In-memory mirror of the hot collections, plus the write path."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        #: collection -> doc_id -> model instance
        self._docs: dict[str, dict[str, Any]] = {c: {} for c in schema.ALL_COLLECTIONS}
        #: collection -> monotonically increasing version, for memoised analytics
        self._revision: dict[str, int] = {c: 0 for c in schema.ALL_COLLECTIONS}
        self._loaded: set[str] = set()
        self._listeners: dict[str, Any] = {}
        self._event_key: str = ""
        self.backend: Any = None
        self.ready = False
        self.error = ""
        #: pending coalesced writes: (collection, doc_id) -> (model, due_at)
        self._pending: dict[tuple[str, str], tuple[Any, float]] = {}
        self._durable_lock = threading.RLock()
        self._flusher: Optional[threading.Thread] = None
        self._stop = threading.Event()
        #: last time each document was actually written (rate-limit guard)
        self._last_write: dict[tuple[str, str], float] = {}
        #: Canonical form of what Firestore currently holds for each document.
        #: The dirty check compares against THIS, not against the cached model
        #:: callers mutate the cached object in place (``m = repo.match(...);
        #: m.betting_locked = True; repo.save_match(m)``), so comparing a model
        #: to itself would always look unchanged and the write would be lost.
        self._written: dict[tuple[str, str], str] = {}

    # ---- lifecycle -------------------------------------------------------- #
    def start(self, data_dir: Path) -> None:
        """Pick a backend, load the global collections, start the flusher."""
        if fs.project_id() or fs.using_emulator():
            if fs.try_get_client() is None:
                self.error = (
                    "Firestore is configured but unreachable: " + fs.init_error()
                )
                log.error(self.error)
            else:
                self.backend = FirestoreBackend()
        if self.backend is None and not (fs.project_id() or fs.using_emulator()):
            self.backend = LocalBackend(data_dir / "hazehub-local.json")
            log.warning(
                "No Firebase project configured: using the local dev store at %s. "
                "Set FIREBASE_PROJECT_ID (or FIRESTORE_EMULATOR_HOST) for Firestore.",
                self.backend.path,
            )
        if self.backend is None:
            return

        for collection in schema.GLOBAL_CACHED:
            self._load(collection, None)
        # Stripped, because every reader goes through repo.current_event()
        # which strips. A stray space here would scope the event caches to a
        # key nothing ever queries, and the event would look empty.
        self._event_key = self.setting_raw("current_event").strip()
        for collection in schema.EVENT_SCOPED_CACHED:
            self._load(collection, self._event_key or None)

        self._stop.clear()
        self._flusher = threading.Thread(
            target=self._flush_loop, name="hazehub-writer", daemon=True
        )
        self._flusher.start()
        self.ready = True

    def stop(self) -> None:
        self._stop.set()
        self.flush()
        for handle in self._listeners.values():
            try:
                handle.unsubscribe()
            except Exception:  # noqa: BLE001
                pass
        self._listeners.clear()

    def _load(self, collection: str, event_key: Optional[str]) -> None:
        model = MODEL_FOR_COLLECTION.get(collection)
        try:
            raw = self.backend.load(collection, event_key)
        except Exception as exc:  # noqa: BLE001
            self.error = f"Failed to load {collection}: {type(exc).__name__}: {exc}"
            log.error(self.error)
            return
        with self._lock:
            self._docs[collection] = (
                {doc_id: model.from_doc(doc_id, data) for doc_id, data in raw.items()}
                if model
                else dict(raw)
            )
            # Seed the dirty-check baseline from what the server actually has,
            # re-serialised through the model so it is comparable to writes.
            for key in [k for k in self._written if k[0] == collection]:
                self._written.pop(key, None)
            for doc_id, obj in self._docs[collection].items():
                if hasattr(obj, "to_doc"):
                    self._written[(collection, doc_id)] = _canon(obj.to_doc())
            self._revision[collection] += 1
            self._loaded.add(collection)
        if LISTEN:
            self._watch(collection, event_key)
        log.info("loaded %s: %d documents", collection, len(raw))

    def _watch(self, collection: str, event_key: Optional[str]) -> None:
        model = MODEL_FOR_COLLECTION.get(collection)

        def on_change(doc_id: str, data: Optional[dict]) -> None:
            with self._lock:
                if data is None:
                    self._docs[collection].pop(doc_id, None)
                    self._written.pop((collection, doc_id), None)
                else:
                    obj = model.from_doc(doc_id, data) if model else data
                    self._docs[collection][doc_id] = obj
                    if model:
                        self._written[(collection, doc_id)] = _canon(obj.to_doc())
                self._revision[collection] += 1

        old = self._listeners.pop(collection, None)
        if old is not None:
            try:
                old.unsubscribe()
            except Exception:  # noqa: BLE001
                pass
        try:
            handle = self.backend.watch(collection, event_key, on_change)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not watch %s: %s", collection, exc)
            return
        if handle is not None:
            self._listeners[collection] = handle

    def retarget_event(self, event_key: str) -> None:
        """Re-scope the event-filtered collections after the event changes.

        Costs one full read of the new event's documents: a handful of
        thousand reads, at most twice a season.
        """
        event_key = (event_key or "").strip()
        if event_key == self._event_key:
            return
        self._event_key = event_key
        for collection in schema.EVENT_SCOPED_CACHED:
            self._load(collection, event_key or None)

    @property
    def event_key(self) -> str:
        return self._event_key

    # ---- reads (never touch Firestore) ------------------------------------ #
    def get(self, collection: str, doc_id: str) -> Any:
        with self._lock:
            return self._docs.get(collection, {}).get(doc_id)

    def fetch(self, collection: str, doc_id: str) -> Any:
        """Read one document, using cache first and Firestore only on a miss."""
        cached = self.get(collection, doc_id)
        if cached is not None:
            return cached
        if self.backend is None:
            return None
        try:
            data = self.backend.get(collection, doc_id)
        except Exception as exc:  # noqa: BLE001
            log.error("fetch %s/%s failed: %s", collection, doc_id, exc)
            return None
        if data is None:
            return None
        model = MODEL_FOR_COLLECTION.get(collection)
        obj = model.from_doc(doc_id, data) if model else data
        with self._lock:
            self._docs.setdefault(collection, {})[doc_id] = obj
            if hasattr(obj, "to_doc"):
                self._written[(collection, doc_id)] = _canon(obj.to_doc())
            self._revision[collection] += 1
        return obj

    def all(self, collection: str) -> list[Any]:
        with self._lock:
            return list(self._docs.get(collection, {}).values())

    def count(self, collection: str) -> int:
        with self._lock:
            return len(self._docs.get(collection, {}))

    def revision(self, *collections: str) -> tuple[int, ...]:
        """Version stamp used as a memoisation key by ``analytics``."""
        with self._lock:
            return tuple(self._revision.get(c, 0) for c in collections)

    # ---- settings (needed before the models exist) ------------------------ #
    def setting_raw(self, key: str) -> str:
        with self._lock:
            doc = self._docs.get(schema.APP_SETTINGS, {}).get(key)
        if isinstance(doc, dict):
            return str(doc.get("value", "") or "")
        return ""

    def set_setting_raw(self, key: str, value: str) -> None:
        doc = {"key": key, "value": str(value)}
        with self._lock:
            self._docs.setdefault(schema.APP_SETTINGS, {})[key] = doc
            self._revision[schema.APP_SETTINGS] += 1
        self._persist(schema.APP_SETTINGS, key, doc, essential=True)

    def all_settings_raw(self) -> dict[str, str]:
        with self._lock:
            docs = dict(self._docs.get(schema.APP_SETTINGS, {}))
        return {
            k: str(v.get("value", "") or "")
            for k, v in docs.items()
            if isinstance(v, dict)
        }

    # ---- writes ----------------------------------------------------------- #
    def write(self, model: Any, essential: bool = True, force: bool = False) -> bool:
        """Upsert ``model``. Returns True if Firestore was actually written.

        Skips the round trip when the document is identical to what Firestore
        already holds: the dirty check that makes repeated TBA syncs and
        idempotent client retries free.
        """
        collection, doc_id = model.COLLECTION, model.doc_id
        data = model.to_doc()
        size = doc_bytes(data)
        if size > schema.MAX_DOC_BYTES:
            raise WriteTooLarge(
                f"{collection}/{doc_id} is {size // 1024} KiB; Firestore's limit is "
                f"1 MiB and HazeHub refuses above {schema.MAX_DOC_BYTES // 1024} KiB"
            )

        canon = _canon(data)
        key = (collection, doc_id)
        with self._lock:
            unchanged = not force and self._written.get(key) == canon
            self._docs.setdefault(collection, {})[doc_id] = model
            self._revision[collection] += 1
        if unchanged:
            return False
        written = self._persist(collection, doc_id, data, essential=essential)
        if written:
            with self._lock:
                self._written[key] = canon
        return written

    def write_many(self, models: list[Any], essential: bool = True) -> int:
        """Upsert many documents in batches, skipping unchanged ones."""
        ops: list[tuple[str, str, str, Optional[dict]]] = []
        canons: dict[tuple[str, str], str] = {}
        for model in models:
            collection, doc_id = model.COLLECTION, model.doc_id
            data = model.to_doc()
            if doc_bytes(data) > schema.MAX_DOC_BYTES:
                log.error("skipping oversized document %s/%s", collection, doc_id)
                continue
            canon = _canon(data)
            key = (collection, doc_id)
            with self._lock:
                changed = self._written.get(key) != canon
                self._docs.setdefault(collection, {})[doc_id] = model
                self._revision[collection] += 1
            if changed:
                ops.append(("set", collection, doc_id, data))
                canons[key] = canon
        if not ops:
            return 0
        if not fs.guard.allow("write", len(ops), essential=essential):
            log.warning("write budget exhausted; deferring %d writes", len(ops))
            return 0
        self._commit(ops)
        now = time.monotonic()
        with self._lock:
            for _, collection, doc_id, _ in ops:
                self._last_write[(collection, doc_id)] = now
            self._written.update(canons)
        return len(ops)

    def atomic_replace(self, models: list[Any], deletes: list[tuple[str, str]]) -> int:
        with self._durable_lock:
            return self._atomic_replace(models, deletes)

    def _atomic_replace(self, models: list[Any], deletes: list[tuple[str, str]]) -> int:
        """Durably apply one bounded replacement before changing the RAM mirror.

        Schedule CSV imports use this path so validation or a Firestore error
        cannot leave half an event's schedule installed.
        """
        ops: list[tuple[str, str, str, Optional[dict]]] = []
        prepared: list[tuple[Any, str, str, dict, str]] = []
        for model in models:
            collection, doc_id = model.COLLECTION, model.doc_id
            data = model.to_doc()
            if doc_bytes(data) > schema.MAX_DOC_BYTES:
                raise WriteTooLarge(f"{collection}/{doc_id} is too large")
            ops.append(("set", collection, doc_id, data))
            prepared.append((model, collection, doc_id, data, _canon(data)))
        ops.extend(("delete", collection, doc_id, None) for collection, doc_id in deletes)
        if len(ops) > schema.MAX_BATCH_OPS or sum(doc_bytes(op[3]) if op[3] else 64 for op in ops) > schema.MAX_BATCH_BYTES:
            raise WriteTooLarge("The import is too large for one atomic update")
        if not ops:
            return 0
        if not fs.guard.allow("write", len(models), essential=True) or not fs.guard.allow("delete", len(deletes), essential=True):
            raise StoreUnavailable("Firestore operation budget is exhausted")
        try:
            self.backend.commit(ops)
        except Exception as exc:  # noqa: BLE001
            raise StoreUnavailable(str(exc)) from exc
        with self._lock:
            touched: set[str] = set()
            for collection, doc_id in deletes:
                self._pending.pop((collection, doc_id), None)
                self._docs.get(collection, {}).pop(doc_id, None)
                self._written.pop((collection, doc_id), None)
                touched.add(collection)
            for model, collection, doc_id, _, canon in prepared:
                self._pending.pop((collection, doc_id), None)
                if collection not in schema.WRITE_ONLY:
                    self._docs.setdefault(collection, {})[doc_id] = model
                    self._written[(collection, doc_id)] = canon
                touched.add(collection)
            for collection in touched:
                self._revision[collection] += 1
        return len(ops)

    def _commit(self, ops: list[tuple[str, str, str, Optional[dict]]]) -> None:
        """Commit in chunks that respect Firestore's per-commit ceilings.

        Chunking lives here rather than in the backend so the 500-operation
        and 10 MiB limits are honoured no matter which backend is in use.
        """
        try:
            for chunk in _chunks(ops, schema.MAX_BATCH_OPS, schema.MAX_BATCH_BYTES):
                self.backend.commit(chunk)
        except Exception as exc:  # noqa: BLE001
            log.error("batch commit failed: %s", exc)
            raise StoreUnavailable(str(exc)) from exc

    def create(self, model: Any) -> bool:
        """Create-if-absent. Returns False when the document already exists.

        This is how offline replay is made idempotent: ``match_scouting``
        documents are keyed by the client's submission UUID, so a duplicate
        submission is a cheap, explicit False rather than an overwrite.
        """
        collection, doc_id = model.COLLECTION, model.doc_id
        data = model.to_doc()
        size = doc_bytes(data)
        if size > schema.MAX_DOC_BYTES:
            raise WriteTooLarge(
                f"{collection}/{doc_id} is {size // 1024} KiB, over the "
                f"{schema.MAX_DOC_BYTES // 1024} KiB ceiling"
            )
        with self._lock:
            if doc_id in self._docs.get(collection, {}):
                return False
        try:
            created = self.backend.create(collection, doc_id, data)
        except Exception as exc:  # noqa: BLE001
            raise StoreUnavailable(str(exc)) from exc
        if created:
            with self._lock:
                self._docs.setdefault(collection, {})[doc_id] = model
                self._written[(collection, doc_id)] = _canon(data)
                self._revision[collection] += 1
            self._last_write[(collection, doc_id)] = time.monotonic()
        return created

    def create_uncached(self, model: Any) -> bool:
        """Create an immutable large record without retaining its bytes in RAM."""
        data = model.to_doc()
        if doc_bytes(data) > schema.MAX_DOC_BYTES:
            raise WriteTooLarge(f"{model.COLLECTION}/{model.doc_id} is too large")
        if not fs.guard.allow("write", essential=True):
            raise StoreUnavailable("Firestore write budget is exhausted")
        try:
            return self.backend.create(model.COLLECTION, model.doc_id, data)
        except Exception as exc:  # noqa: BLE001
            raise StoreUnavailable(str(exc)) from exc

    def delete(self, collection: str, doc_id: str, essential: bool = True) -> None:
        with self._lock:
            self._docs.get(collection, {}).pop(doc_id, None)
            self._written.pop((collection, doc_id), None)
            self._pending.pop((collection, doc_id), None)
            self._revision[collection] += 1
        if not fs.guard.allow("delete", essential=essential):
            return
        try:
            self.backend.delete(collection, doc_id)
        except Exception as exc:  # noqa: BLE001
            log.error("delete %s/%s failed: %s", collection, doc_id, exc)

    def delete_many(self, collection: str, doc_ids: list[str]) -> int:
        ops: list[tuple[str, str, str, Optional[dict]]] = []
        with self._lock:
            for doc_id in doc_ids:
                self._docs.get(collection, {}).pop(doc_id, None)
                self._written.pop((collection, doc_id), None)
                self._pending.pop((collection, doc_id), None)
                ops.append(("delete", collection, doc_id, None))
            if ops:
                self._revision[collection] += 1
        if not ops:
            return 0
        try:
            self._commit(ops)
        except StoreUnavailable:
            return 0
        return len(ops)

    def coalesce(self, model: Any, delay_s: float = 5.0) -> None:
        """Apply ``model`` now, write it to Firestore at most once per ``delay_s``.

        For counters like ``matches_scouted`` that change on a request but do
        not need to be durable within the second: this collapses a burst of
        submissions from one scout into a single document write and keeps the
        document under Firestore's ~1 write/second sustained limit.
        """
        collection, doc_id = model.COLLECTION, model.doc_id
        with self._lock:
            self._docs.setdefault(collection, {})[doc_id] = model
            self._revision[collection] += 1
            self._pending[(collection, doc_id)] = (model, time.monotonic() + delay_s)

    def flush(self) -> int:
        with self._durable_lock:
            return self._flush_pending()

    def _flush_pending(self) -> int:
        """Write every coalesced document that is due (or all, on shutdown)."""
        now = time.monotonic()
        shutting_down = self._stop.is_set()
        with self._lock:
            due = [
                (key, model)
                for key, (model, due_at) in self._pending.items()
                if shutting_down or due_at <= now
            ]
            for key, _ in due:
                self._pending.pop(key, None)
        if not due:
            return 0
        return self.write_many([model for _, model in due], essential=False)

    def _flush_loop(self) -> None:
        while not self._stop.wait(FLUSH_INTERVAL_S):
            try:
                self.flush()
            except Exception as exc:  # noqa: BLE001: the loop must never die
                log.error("flush failed: %s", exc)

    def _persist(
        self, collection: str, doc_id: str, data: dict, essential: bool
    ) -> bool:
        if self.backend is None:
            raise StoreUnavailable("No datastore configured")
        if not fs.guard.allow("write", essential=essential):
            log.warning("write budget exhausted; dropped %s/%s", collection, doc_id)
            return False
        try:
            self.backend.set(collection, doc_id, data)
        except Exception as exc:  # noqa: BLE001
            log.error("write %s/%s failed: %s", collection, doc_id, exc)
            raise StoreUnavailable(str(exc)) from exc
        self._last_write[(collection, doc_id)] = time.monotonic()
        return True

    # ---- diagnostics ------------------------------------------------------ #
    def stats(self) -> dict[str, Any]:
        with self._lock:
            sizes = {c: len(d) for c, d in self._docs.items() if d}
            pending = len(self._pending)
        return {
            "backend": self.backend.name if self.backend else "none",
            "ready": self.ready,
            "listeners": sorted(self._listeners) if LISTEN else [],
            "listen_mode": LISTEN,
            "event_key": self._event_key,
            "documents": sizes,
            "cached_total": sum(sizes.values()),
            "pending_writes": pending,
            "error": self.error,
        }


#: Fields that move on every save and carry no information worth a write.
#: ``updated_at`` in particular: if it counted, the dirty check would never
#: fire and every TBA sync would rewrite the whole 120-match schedule.
_VOLATILE_FIELDS = ("updated_at", "azure_received_at", "megascout_received_at")


def _canon(data: dict[str, Any]) -> str:
    """Stable comparison key for a document, ignoring volatile fields."""
    return json.dumps(
        {k: v for k, v in data.items() if k not in _VOLATILE_FIELDS},
        sort_keys=True,
        default=str,
    )


store = Store()
