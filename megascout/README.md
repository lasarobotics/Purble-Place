# MegaScout — on-prem event server

The always-on server described in the Strategy Router architecture: the primary
node every scouting/admin device talks to over the event LAN. It owns the
PostgreSQL database of record, acknowledges submissions over WebSocket, and
ships them to Azure asynchronously through a durable transactional outbox.

```
device (IndexedDB) ──HTTP──▶ MegaScout API ──┬─▶ PostgreSQL commit ──▶ WebSocket ack
                                             └─▶ outbox row (same txn)
                                                     │
                                        sync worker ─┴─▶ Azure   (retries, idempotent)
```

## Run it

```bash
cd megascout
cp .env.example .env          # set POSTGRES_PASSWORD, HAZEHUB_SECRET, TBA_AUTH_KEY
docker compose --env-file .env up -d --build
```

- App:  `http://<megascout-host>/`  (sign in with a Scouter ID + team password; `admin` is privileged)
- API docs: `http://<megascout-host>/docs`
- Health:   `http://<megascout-host>/api/health`

Enable TLS by dropping `fullchain.pem` + `privkey.pem` into `nginx/certs/` and
uncommenting the 443 block in `nginx/nginx.conf`.

## Services

| Service    | Role |
| ---------- | ---- |
| `nginx`    | TLS reverse proxy → web, `/api`+`/docs` → api, `/ws` → api (WebSocket) |
| `web`      | Next.js PWA (same-origin, no CORS) |
| `api`      | FastAPI — commits scouting + writes the Azure outbox row in one transaction |
| `worker`   | Azure sync worker — drains the outbox, idempotent, retries forever, never drops |
| `postgres` | Database of record; **not** published to the host's external interfaces |
| `backup`   | Periodic `pg_dump` to the `backups` volume (third recovery layer) |

## Azure sync

`CLOUD_SYNC_URL` blank ⇒ **local-only**: submissions still commit and queue
durably; nothing ships until an uplink + URL exist (the "works with no
internet" case). Set it to the Azure ingest endpoint (and `CLOUD_SYNC_KEY`
bearer) to turn on sync. Every submission carries a UUID; the cloud dedupes on
it, so retries after a half-failed send are safe.

## Recovery layers

1. Devices keep their IndexedDB submissions until the event ends.
2. PostgreSQL on MegaScout is the record of truth.
3. `backup` writes periodic compressed `pg_dump` snapshots to the `backups` volume.

Watch all of the above live at **Admin → System Health**.

## Failover to a spare laptop

The spare needs Docker, this repo, a copy of `.env`, and (ideally) a restored
`pg_dump`. Bring the stack up, restore the latest dump into Postgres, and point
the event DNS/static IP at the spare. Devices replay any IndexedDB submissions
that lack a MegaScout acknowledgement — the submission UUID makes the replay
idempotent, so nothing double-counts.
