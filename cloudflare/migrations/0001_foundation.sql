-- Staging only. Never import into the production Firestore database.
PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL,
  credential_revision TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  s_number INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE event_revisions (event_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE reports (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, team INTEGER NOT NULL CHECK(team>0),
  match_number INTEGER NOT NULL CHECK(match_number>0), owner_id TEXT NOT NULL REFERENCES accounts(id),
  payload TEXT NOT NULL CHECK(json_valid(payload)), payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, voided INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX reports_event_cursor ON reports(event_id, id);
CREATE INDEX reports_event_team ON reports(event_id, team);
CREATE TABLE audit (
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id), actor TEXT NOT NULL,
  previous_version INTEGER NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(report_id, previous_version)
);
CREATE TABLE dirty_teams (
  event_id TEXT NOT NULL, team INTEGER NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(event_id,team)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, event_id TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
  error TEXT, result_ref TEXT, expires_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs(status,next_attempt_at,lease_until);
CREATE TABLE snapshots (
  event_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body)), digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(event_id,kind)
);
CREATE TABLE meetings (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL DEFAULT '{"first":[],"second":[]}' CHECK(json_valid(body)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE meeting_operations (
  id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), actor TEXT NOT NULL,
  expected_revision INTEGER NOT NULL, payload_hash TEXT NOT NULL,
  revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(meeting_id,expected_revision)
);
CREATE TABLE socket_tickets (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), meeting_id TEXT NOT NULL,
  credential_revision TEXT NOT NULL, expires_at INTEGER NOT NULL, session_expires_at INTEGER NOT NULL
);
CREATE INDEX socket_tickets_expiry ON socket_tickets(expires_at);
-- Immutable migration landing zone preserves every original document, including
-- game definitions, pit photos, picklists and credential records, without coercion.
CREATE TABLE source_documents (
  collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  sha256 TEXT NOT NULL, PRIMARY KEY(collection,id)
);
CREATE TABLE migration_runs (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, imported_at INTEGER NOT NULL);

-- A report, its revision, dirty markers and durable outbox are ONE transaction.
CREATE TRIGGER report_created AFTER INSERT ON reports BEGIN
  INSERT INTO event_revisions VALUES(NEW.event_id,1)
    ON CONFLICT(event_id) DO UPDATE SET revision=revision+1;
  INSERT INTO dirty_teams SELECT NEW.event_id,NEW.team,revision FROM event_revisions WHERE event_id=NEW.event_id
    ON CONFLICT(event_id,team) DO UPDATE SET revision=excluded.revision;
  INSERT INTO jobs(id,type,event_id,idempotency_key,created_at,expires_at)
    VALUES('overview:'||NEW.event_id,'overview',NEW.event_id,'overview:'||NEW.event_id,NEW.created_at,NEW.created_at+604800000)
    ON CONFLICT(id) DO UPDATE SET status='pending', attempts=0, lease_until=0, next_attempt_at=0, expires_at=excluded.expires_at;
END;
CREATE TRIGGER report_changed AFTER UPDATE ON reports BEGIN
  UPDATE event_revisions SET revision=revision+1 WHERE event_id=NEW.event_id;
  INSERT INTO dirty_teams SELECT NEW.event_id,NEW.team,revision FROM event_revisions WHERE event_id=NEW.event_id
    ON CONFLICT(event_id,team) DO UPDATE SET revision=excluded.revision;
  INSERT INTO jobs(id,type,event_id,idempotency_key,created_at,expires_at)
    VALUES('overview:'||NEW.event_id,'overview',NEW.event_id,'overview:'||NEW.event_id,NEW.created_at,NEW.created_at+604800000)
    ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=0,next_attempt_at=0,expires_at=excluded.expires_at;
END;
