#!/bin/sh
# Periodic PostgreSQL backups for MegaScout. Runs pg_dump on an interval and
# keeps the most recent $BACKUP_KEEP dumps. Never touches the outbox rows —
# this is a full-database snapshot, a third recovery layer alongside the
# devices' IndexedDB and Postgres itself.
set -eu

INTERVAL="${BACKUP_INTERVAL_SECONDS:-3600}"
KEEP="${BACKUP_KEEP:-48}"
DIR=/backups

mkdir -p "$DIR"
echo "[backup] starting: every ${INTERVAL}s, keeping ${KEEP} dumps in ${DIR}"

while true; do
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT="$DIR/hazehub-$TS.sql.gz"
  if pg_dump | gzip > "$OUT"; then
    echo "[backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"
  else
    echo "[backup] FAILED at $TS" >&2
    rm -f "$OUT"
  fi
  # Prune all but the newest $KEEP dumps.
  ls -1t "$DIR"/hazehub-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old" && echo "[backup] pruned $old"
  done
  sleep "$INTERVAL"
done
