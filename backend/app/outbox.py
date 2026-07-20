"""Transactional outbox helpers — the durable MegaScout → Azure queue.

The core guarantee (transactional outbox pattern): a scouting record and its
"ship this to Azure" instruction are written in the SAME database transaction.
If the commit succeeds, the record is both persisted AND queued; if it fails,
neither exists. There is no window where a record is saved locally but lost to
the cloud, and nothing here ever deletes an outbox row.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlmodel import Session, func, select

from .config import settings
from .models import OutboxRecord, ScoutEntry


def _now() -> datetime:
    return datetime.now(timezone.utc)


def commit_submission(session: Session, entry: ScoutEntry) -> ScoutEntry:
    """Persist a scouting record and enqueue its outbox row atomically.

    Caller is responsible for any other objects already added to ``session``
    (e.g. the scouter counter, match lock); they all commit together here.
    """
    entry.megascout_receipt_ts = _now()
    entry.cloud_status = "queued"
    session.add(entry)
    session.flush()  # assign entry.id without ending the transaction

    session.add(
        OutboxRecord(
            submission_id=entry.submission_id,
            aggregate_type="match_scouting",
            aggregate_id=str(entry.id),
            event_key=entry.event_key,
            match_number=entry.match_number,
            team_number=entry.team_number,
            scout_id=entry.scout_id,
            payload=entry.envelope(),
            status="queued",
            client_ts=entry.client_ts,
            created_at=entry.megascout_receipt_ts,
            next_attempt_at=entry.megascout_receipt_ts,
        )
    )
    session.commit()
    session.refresh(entry)
    return entry


# --------------------------------------------------------------------------- #
# Worker-side helpers                                                          #
# --------------------------------------------------------------------------- #
def claim_batch(session: Session, limit: int) -> list[OutboxRecord]:
    """Rows that are due for a (re)send, oldest first."""
    now = _now()
    stmt = (
        select(OutboxRecord)
        .where(OutboxRecord.status != "sent")
        .where(OutboxRecord.next_attempt_at <= now)
        .order_by(OutboxRecord.created_at)
        .limit(limit)
    )
    return list(session.exec(stmt).all())


def mark_sent(session: Session, row: OutboxRecord, azure_ts: datetime) -> None:
    row.status = "sent"
    row.attempts += 1
    row.last_error = ""
    row.azure_receipt_ts = azure_ts
    session.add(row)
    # Mirror the terminal state onto the source record for the API/health panel.
    entry = session.exec(
        select(ScoutEntry).where(ScoutEntry.submission_id == row.submission_id)
    ).first()
    if entry is not None:
        entry.cloud_status = "synced"
        entry.azure_receipt_ts = azure_ts
        session.add(entry)
    session.commit()


def mark_failed(session: Session, row: OutboxRecord, error: str) -> None:
    row.attempts += 1
    row.status = "failed"
    row.last_error = error[:2000]
    # Exponential backoff, capped — a record is never dropped, only deferred.
    delay = min(
        settings.SYNC_MAX_BACKOFF_SECONDS,
        settings.SYNC_INTERVAL_SECONDS * (2 ** min(row.attempts, 8)),
    )
    row.next_attempt_at = _now() + timedelta(seconds=delay)
    session.add(row)
    entry = session.exec(
        select(ScoutEntry).where(ScoutEntry.submission_id == row.submission_id)
    ).first()
    if entry is not None and entry.cloud_status != "synced":
        entry.cloud_status = "failed"
        session.add(entry)
    session.commit()


# --------------------------------------------------------------------------- #
# Health-panel queries                                                         #
# --------------------------------------------------------------------------- #
def outbox_stats(session: Session) -> dict:
    def _count(*conds) -> int:
        stmt = select(func.count()).select_from(OutboxRecord)
        for c in conds:
            stmt = stmt.where(c)
        return int(session.exec(stmt).one())

    total = _count()
    sent = _count(OutboxRecord.status == "sent")
    failed = _count(OutboxRecord.status == "failed")
    queued = total - sent
    return {
        "total": total,
        "sent": sent,
        "failed": failed,
        "unsynced": queued,  # queued + failed = everything not yet in Azure
    }


def oldest_unsynced(session: Session) -> Optional[OutboxRecord]:
    stmt = (
        select(OutboxRecord)
        .where(OutboxRecord.status != "sent")
        .order_by(OutboxRecord.created_at)
        .limit(1)
    )
    return session.exec(stmt).first()
