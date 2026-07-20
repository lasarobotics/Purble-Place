"""Azure synchronization worker.

A standalone process (``python -m app.sync_worker``) that drains the
transactional outbox to the cloud. It is deliberately decoupled from the
request path: scouting submits commit locally and return immediately; this
worker ships them to Azure asynchronously and durably.

Guarantees:
* **At-least-once, idempotent.** Every submission carries a UUID; the cloud is
  expected to dedupe on it, so a retry after a half-failed send is safe. A
  409/duplicate from the cloud counts as success.
* **Never drops data.** A failed row is backed off and retried forever; rows
  are only ever marked ``sent``, never deleted.
* **Degrades to local-only.** With no ``CLOUD_SYNC_URL`` configured the worker
  still runs and heartbeats, leaving records durably queued until an uplink
  (and cloud URL) exist — exactly the "MegaScout works with no internet" case.
"""
from __future__ import annotations

import argparse
import logging
import time
from datetime import datetime, timezone

import httpx
from sqlmodel import Session

from .config import settings
from .database import engine, init_db
from .models import OutboxRecord, WorkerHeartbeat
from .outbox import claim_batch, mark_failed, mark_sent

log = logging.getLogger("hazehub.sync")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ship_one(client: httpx.Client, row: OutboxRecord) -> datetime:
    """POST one submission to the cloud. Returns the Azure receipt timestamp.

    Raises on any non-success so the caller backs the row off. A 409 (the
    cloud already has this submission_id) is treated as success — that's the
    idempotency key doing its job after a retry.
    """
    headers = {"Content-Type": "application/json"}
    if settings.CLOUD_SYNC_KEY:
        headers["Authorization"] = f"Bearer {settings.CLOUD_SYNC_KEY}"
    resp = client.post(settings.CLOUD_SYNC_URL, json=row.payload, headers=headers)
    if resp.status_code == 409:
        return _now()
    resp.raise_for_status()
    # Honour a cloud-provided receipt time if present, else stamp now.
    try:
        body = resp.json()
        ts = body.get("azure_receipt_ts") or body.get("received_at")
        if ts:
            return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:
        pass
    return _now()


def run_once(session: Session, client: httpx.Client | None = None) -> int:
    """Process one batch. Returns the number of rows shipped to the cloud."""
    if not settings.CLOUD_SYNC_ENABLED:
        _heartbeat(session, synced=0, error="", reachable=False)
        return 0

    rows = claim_batch(session, settings.SYNC_BATCH_SIZE)
    if not rows:
        _heartbeat(session, synced=0, error="", reachable=True)
        return 0

    owns_client = client is None
    client = client or httpx.Client(timeout=15.0)
    synced = 0
    last_error = ""
    reachable = True
    try:
        for row in rows:
            try:
                azure_ts = _ship_one(client, row)
                mark_sent(session, row, azure_ts)
                synced += 1
            except Exception as exc:  # noqa: BLE001 — record + back off, never crash
                last_error = f"{type(exc).__name__}: {exc}"
                reachable = False
                mark_failed(session, row, last_error)
                log.warning("outbox %s failed: %s", row.submission_id, last_error)
    finally:
        if owns_client:
            client.close()
    _heartbeat(session, synced=synced, error=last_error, reachable=reachable)
    return synced


def _heartbeat(session: Session, *, synced: int, error: str, reachable: bool) -> None:
    hb = session.get(WorkerHeartbeat, "azure_sync") or WorkerHeartbeat(name="azure_sync")
    hb.last_beat = _now()
    hb.last_synced = synced
    hb.last_error = error[:2000]
    hb.cloud_reachable = reachable
    session.add(hb)
    session.commit()


def run_forever() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    init_db()
    mode = settings.CLOUD_SYNC_URL if settings.CLOUD_SYNC_ENABLED else "local-only (no CLOUD_SYNC_URL)"
    log.info("Azure sync worker started → %s", mode)
    while True:
        try:
            with Session(engine) as session:
                n = run_once(session)
            if n:
                log.info("shipped %d submission(s) to the cloud", n)
        except Exception as exc:  # noqa: BLE001 — the worker must never die
            log.exception("sync cycle error: %s", exc)
        time.sleep(settings.SYNC_INTERVAL_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser(description="HazeHub Azure sync worker")
    parser.add_argument(
        "--once", action="store_true", help="Process a single batch and exit."
    )
    args = parser.parse_args()
    if args.once:
        logging.basicConfig(level=logging.INFO)
        init_db()
        with Session(engine) as session:
            print("shipped:", run_once(session))
    else:
        run_forever()


if __name__ == "__main__":
    main()
