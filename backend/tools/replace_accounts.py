"""Replace Firestore scouter accounts with the checked-in spreadsheet roster.

This deliberately touches only the ``scouters`` collection. Historical match,
pit, betting, and picklist records keep their original account references.
The previous account documents are backed up locally before any writes occur.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore


BACKEND_DIR = Path(__file__).resolve().parents[1]
ROSTER_FILE = BACKEND_DIR / "app" / "account_roster.json"
BACKUP_DIR = BACKEND_DIR / "data" / "account-backups"
COLLECTION = "scouters"


def _client():
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not raw:
        raise SystemExit("FIREBASE_SERVICE_ACCOUNT is required")
    info = json.loads(raw)
    if info.get("project_id") != "hazehub-8a941":
        raise SystemExit("Refusing to modify an unexpected Firebase project")
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(info))
    return firestore.client()


def _backup(rows: dict[str, dict]) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = BACKUP_DIR / f"scouters-{timestamp}.json"
    target.write_text(
        json.dumps(rows, indent=2, default=lambda value: value.isoformat()),
        encoding="utf-8",
    )
    return target


def main() -> None:
    roster = json.loads(ROSTER_FILE.read_text(encoding="utf-8"))
    if len(roster) != 65 or len(set(roster)) != 65:
        raise SystemExit("Expected exactly 65 unique spreadsheet IDs")

    client = _client()
    collection = client.collection(COLLECTION)
    snapshots = list(collection.stream())
    existing = {snapshot.id: snapshot.to_dict() for snapshot in snapshots}
    backup = _backup(existing)

    legacy_admin_id = next((key for key in existing if key.lower() == "admin"), None)
    admin = dict(existing.get(legacy_admin_id, {})) if legacy_admin_id else {}
    now = datetime.now(timezone.utc)
    admin.update({
        "scouter_id": "Admin",
        "display_name": admin.get("display_name") or "Administrator",
        "role": "admin",
        "is_admin": True,
        "bucks": int(admin.get("bucks", 100)),
        "matches_scouted": int(admin.get("matches_scouted", 0)),
        "last_login": admin.get("last_login") or now,
        "created_at": admin.get("created_at") or now,
    })

    wanted: dict[str, dict] = {"Admin": admin}
    next_number = max(
        [int(row.get("s_number") or 0) for row in existing.values()] + [0]
    ) + 1
    for scout_id in roster:
        row = dict(existing.get(scout_id, {}))
        row.update({
            "scouter_id": scout_id,
            "display_name": row.get("display_name") or f"Scout {scout_id}",
            "role": "scouter",
            "is_admin": False,
            "password_hash": row.get("password_hash") or "",
            "bucks": int(row.get("bucks", 100)),
            "matches_scouted": int(row.get("matches_scouted", 0)),
            "last_login": row.get("last_login") or now,
            "created_at": row.get("created_at") or now,
        })
        if not row.get("s_number"):
            row["s_number"] = next_number
            next_number += 1
        wanted[scout_id] = row

    operations: list[tuple[str, str, dict | None]] = []
    operations.extend(("set", key, value) for key, value in wanted.items())
    operations.extend(("delete", key, None) for key in existing if key not in wanted)
    for offset in range(0, len(operations), 400):
        batch = client.batch()
        for action, key, value in operations[offset : offset + 400]:
            ref = collection.document(key)
            if action == "set":
                batch.set(ref, value)
            else:
                batch.delete(ref)
        batch.commit()

    final = {snapshot.id: snapshot.to_dict() for snapshot in collection.stream()}
    if set(final) != set(wanted):
        raise SystemExit("Verification failed: final account IDs do not match roster")
    admins = [key for key, value in final.items() if value.get("is_admin")]
    if admins != ["Admin"]:
        raise SystemExit(f"Verification failed: administrators are {admins!r}")
    unclaimed = sum(not value.get("password_hash") for key, value in final.items() if key != "Admin")
    print(f"Backup: {backup}")
    print(f"Accounts: {len(final)} (1 Admin + {len(roster)} roster members)")
    print(f"Members awaiting first-use password setup: {unclaimed}")


if __name__ == "__main__":
    main()
