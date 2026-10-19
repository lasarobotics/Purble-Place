-- Incremental analytics, Workers-compatible auth, and external cache.
-- Staging only. Never write into the production Firestore database.
PRAGMA foreign_keys = ON;

ALTER TABLE accounts ADD COLUMN password_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS game_definitions (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL CHECK(json_valid(body)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_metrics (
  event_id TEXT NOT NULL,
  team INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  avg_points REAL,
  matches INTEGER NOT NULL DEFAULT 0,
  defense_matches INTEGER NOT NULL DEFAULT 0,
  climb_rate REAL,
  consistency REAL,
  body TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(body)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(event_id, team)
);

CREATE TABLE IF NOT EXISTS external_cache (
  cache_key TEXT PRIMARY KEY,
  body TEXT NOT NULL CHECK(json_valid(body)),
  digest TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS external_cache_expiry ON external_cache(expires_at);

CREATE TABLE IF NOT EXISTS page_snapshots (
  event_id TEXT NOT NULL,
  page TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body)),
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(event_id, page)
);

-- Seed a staging scoring definition used by the Haze Power Rating estimator.
-- Point values are illustrative for prototype-demo; production imports real season defs.
INSERT OR IGNORE INTO game_definitions(id, body, updated_at) VALUES(
  'staging-default',
  '{"accuracy_smoothing_k":20,"endgame_none":"none","endgame":{"none":0,"park":2,"l1":3,"l2":4,"l3":6,"l4":12},"attempt_points":{"auto|score||":4,"teleop|score||":2},"rules":[]}',
  0
);

-- Coalesce analytics rebuilds onto one durable outbox row per event.
CREATE TRIGGER IF NOT EXISTS report_created_analysis AFTER INSERT ON reports BEGIN
  INSERT INTO jobs(id,type,event_id,idempotency_key,created_at,expires_at,priority)
    VALUES('analysis:'||NEW.event_id,'analysis',NEW.event_id,'analysis:'||NEW.event_id,NEW.created_at,NEW.created_at+604800000,10)
    ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=0,next_attempt_at=0,expires_at=excluded.expires_at;
END;

CREATE TRIGGER IF NOT EXISTS report_changed_analysis AFTER UPDATE ON reports BEGIN
  INSERT INTO jobs(id,type,event_id,idempotency_key,created_at,expires_at,priority)
    VALUES('analysis:'||NEW.event_id,'analysis',NEW.event_id,'analysis:'||NEW.event_id,NEW.created_at,NEW.created_at+604800000,10)
    ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=0,next_attempt_at=0,expires_at=excluded.expires_at;
END;
