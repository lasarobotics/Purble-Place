"""Datastore lifecycle.

There is no connection pool and no session any more: :mod:`cache` holds the
working set in memory and writes through to Cloud Firestore. This module is
just the boot and shutdown hook the FastAPI lifespan calls, kept under the
old name so the import graph reads the same as before.
"""
from __future__ import annotations

import logging

from .cache import store
from .config import settings

log = logging.getLogger("hazehub.database")


def init_db() -> None:
    """Connect to Firestore and load the working set into memory.

    Safe to call twice; the second call is a no-op.
    """
    if store.ready:
        return
    store.start(settings.DATA_DIR)
    log.info("datastore ready: %s", store.stats())


def close_db() -> None:
    """Flush coalesced writes and detach any snapshot listeners."""
    store.stop()


def healthy() -> bool:
    return store.ready and not store.error
