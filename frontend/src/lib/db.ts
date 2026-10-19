// Local-first storage (Dexie / IndexedDB), the device's database of record.
//
// Every submission is saved here BEFORE any network request, keeps its UUID
// and payload hash for its whole life, and remains stored through the event
// even after the cloud acknowledges it (recovery layer #1). sync.ts drives
// the syncStatus state machine over these rows.
import { localOwner } from "./identity";
import Dexie, { Table } from "dexie";
import type { MatchRec, ScoutEntry } from "./types";

export type SyncStatus =
  | "queued"
  | "sending"
  | "acknowledged"
  | "retry_wait"
  | "invalid"
  | "auth_required"
  | "conflict";

export interface PendingScout extends ScoutEntry {
  owner_id?: string;
  client_uuid: string;          // legacy name, equals submission_id
  submission_id?: string;
  payload_hash?: string;
  client_ts?: string;
  queued_at: number;
  sync_status?: SyncStatus;
  attempt_count?: number;
  last_attempt_at?: number | null;
  next_attempt_at?: number | null;
  last_error?: string | null;
  azure_received_at?: string | null;
}

interface Setting {
  key: string;
  value: string;
}

/** One cached match, keyed by match_key, plus when we last saw it. */
export interface CachedMatch extends MatchRec {
  cached_at: number;
}

export interface PendingPit {
  id: string;
  owner_id: string;
  event_key: string;
  team_number: number;
  body: Record<string, any>;
  sync_status: "queued" | "sending" | "acknowledged" | "invalid" | "retry_wait";
  updated_at: number;
  last_error?: string | null;
}

class HazeDB extends Dexie {
  offlineCredentials!: Table<{ id: string; [key: string]: any }, string>;
  pendingScouts!: Table<PendingScout, string>;
  settings!: Table<Setting, string>;
  schedule!: Table<CachedMatch, string>;
  responses!: Table<{ key: string; json: string; saved_at: number; etag?: string }, string>;
  pendingPits!: Table<PendingPit, string>;
  /** Revisioned page/API snapshots for offline-first screens (never holds unsynced scouts). */
  snapshots!: Table<{ key: string; owner_id: string; json: string; etag?: string; revision?: string; saved_at: number }, string>;

  constructor() {
    super("hazehub");
    this.version(1).stores({
      pendingScouts: "client_uuid, team_number, match_number, queued_at",
    });
    // v2: submission lifecycle fields + device settings. Existing rows are
    // upgraded in place as plain queued records.
    this.version(2)
      .stores({
        pendingScouts:
          "client_uuid, team_number, match_number, queued_at, sync_status, next_attempt_at",
        settings: "key",
      })
      .upgrade(async (tx) => {
        await tx
          .table("pendingScouts")
          .toCollection()
          .modify((row: PendingScout) => {
            row.submission_id = row.submission_id || row.client_uuid;
            row.sync_status = row.sync_status || "queued";
            row.attempt_count = row.attempt_count ?? 0;
          });
      });
    // v3: the match schedule, cached on the device. Venue wifi drops, and a
    // scout who cannot see which robot they are watching cannot scout.
    this.version(3).stores({
      pendingScouts:
        "client_uuid, team_number, match_number, queued_at, sync_status, next_attempt_at",
      settings: "key",
      schedule: "match_key, event_key, match_number, comp_level",
    });
    this.version(4).stores({
      pendingScouts: "client_uuid, team_number, match_number, queued_at, sync_status, next_attempt_at, owner_id",
      settings: "key", schedule: "match_key, event_key, match_number, comp_level", responses: "key, saved_at",
    });
    this.version(5).stores({
      pendingScouts: "client_uuid, team_number, match_number, queued_at, sync_status, next_attempt_at, owner_id",
      settings: "key",
      schedule: "match_key, event_key, match_number, comp_level",
      responses: "key, saved_at",
      pendingPits: "id, owner_id, event_key, team_number, sync_status, updated_at",
    });
    this.version(6).stores({ offlineCredentials: "id" }).upgrade(async tx => {
      const pits = tx.table("pendingPits");
      for (const row of await pits.toArray()) {
        const id = `${row.owner_id}:${row.event_key}:${row.team_number}`;
        if (row.owner_id && row.id === `${row.event_key}:${row.team_number}` && !await pits.get(id)) {
          await pits.put({ ...row, id });
          await pits.delete(row.id);
        }
      }
    });
    // v7: revision/ETag page snapshots. Pending scouts and recovery rows are never stored here.
    this.version(7).stores({
      snapshots: "key, owner_id, saved_at, revision",
    });
  }
}

let _db: HazeDB | null = null;
export function db(): HazeDB {
  if (!_db) _db = new HazeDB();
  return _db;
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const UNSYNCED: SyncStatus[] = ["queued", "sending", "retry_wait"];

export async function queueScout(entry: PendingScout) {
  if (!localOwner()) throw new Error("Sign in before saving scouting data.");
  await db().pendingScouts.put({
    sync_status: "queued",
    attempt_count: 0,
    last_attempt_at: null,
    next_attempt_at: null,
    last_error: null,
    azure_received_at: null,
    ...entry,
    owner_id: localOwner(),
    submission_id: entry.submission_id || entry.client_uuid,
  });
  window.dispatchEvent(new Event("scout-queue-changed"));
}

/** Records still owed to the cloud (queued / sending / waiting to retry). */
export async function pendingScouts(): Promise<PendingScout[]> {
  const rows = await db().pendingScouts.orderBy("queued_at").toArray();
  return rows.filter((r) => UNSYNCED.includes(r.sync_status || "queued") && r.owner_id === localOwner());
}

export async function allLocalScouts(): Promise<PendingScout[]> {
  return db().pendingScouts.orderBy("queued_at").toArray();
}

/** Cloud confirmed these, keep the rows (recovery layer), flip the status. */
export async function markAcknowledged(uuids: string[], receivedAt?: string) {
  if (!uuids.length) return;
  await db()
    .pendingScouts.where("client_uuid")
    .anyOf(uuids)
    .modify({
      sync_status: "acknowledged",
      last_error: null,
      azure_received_at: receivedAt || new Date().toISOString(),
    });
  window.dispatchEvent(new Event("scout-queue-changed"));
}

export async function markStatus(uuid: string, status: SyncStatus, error?: string) {
  await db().pendingScouts.update(uuid, {
    sync_status: status,
    last_error: error || null,
  });
}

export async function markRetry(uuid: string, attemptCount: number, nextAt: number, error?: string) {
  await db().pendingScouts.update(uuid, {
    sync_status: "retry_wait",
    attempt_count: attemptCount,
    last_attempt_at: Date.now(),
    next_attempt_at: nextAt,
    last_error: error || null,
  });
}

// Kept for compatibility: "removing" pending records now means acknowledging
// them, local copies survive the event per the recovery design.
export async function removePending(uuids: string[]) {
  await markAcknowledged(uuids);
}

export async function pendingCount(): Promise<number> {
  return (await pendingScouts()).length;
}

export async function queuePit(body: Record<string, any>): Promise<PendingPit> {
  if (!localOwner()) throw new Error("Sign in before saving scouting data.");
  const row: PendingPit = {
    id: `${localOwner()}:${body.event_key}:${Number(body.team_number)}`,
    owner_id: localOwner(),
    event_key: String(body.event_key || ""),
    team_number: Number(body.team_number),
    body,
    sync_status: "queued",
    updated_at: Date.now(),
    last_error: null,
  };
  await db().pendingPits.put(row);
  window.dispatchEvent(new Event("pit-queue-changed"));
  return row;
}

export async function pendingPits(): Promise<PendingPit[]> {
  const rows = await db().pendingPits.where("owner_id").equals(localOwner()).toArray();
  return rows.filter(row => row.sync_status !== "acknowledged" && row.sync_status !== "invalid");
}

export interface QueueStats {
  total: number;
  queued: number;
  acknowledged: number;
  invalid: number;
  conflict: number;
  oldestQueued: PendingScout | null;
  lastAcknowledgedAt: string | null;
}

export async function queueStats(): Promise<QueueStats> {
  const rows = await allLocalScouts();
  const un = rows.filter((r) => UNSYNCED.includes(r.sync_status || "queued"));
  const acked = rows.filter((r) => r.sync_status === "acknowledged");
  const lastAck = acked
    .map((r) => r.azure_received_at || "")
    .filter(Boolean)
    .sort()
    .pop();
  return {
    total: rows.length,
    queued: un.length,
    acknowledged: acked.length,
    invalid: rows.filter((r) => r.sync_status === "invalid").length,
    conflict: rows.filter((r) => r.sync_status === "conflict").length,
    oldestQueued: un[0] || null,
    lastAcknowledgedAt: lastAck || null,
  };
}

// ---- Offline match schedule ------------------------------------------------
// The schedule is small, changes rarely, and is useless to fetch when the
// venue wifi is gone. It is written to IndexedDB every time we successfully
// load it, so a device that drops offline still knows which robot each scout
// is watching. Scores change over the day, so the cache is replaced wholesale
// rather than merged.

const SCHEDULE_EVENT_KEY = "scheduleEvent";
const SCHEDULE_SAVED_KEY = "scheduleSavedAt";

export async function cacheSchedule(eventKey: string, matches: MatchRec[]) {
  if (!matches.length) return;
  const now = Date.now();
  const rows: CachedMatch[] = matches.map((m) => ({ ...m, cached_at: now }));
  await db().transaction("rw", db().schedule, db().settings, async () => {
    const stale = await db().schedule.where("event_key").notEqual(eventKey).primaryKeys();
    if (stale.length) await db().schedule.bulkDelete(stale as string[]);
    const existing = await db().schedule.bulkGet(rows.map(row => row.match_key));
    const changed = rows.filter((row, i) => {
      const old = existing[i];
      if (!old) return true;
      const {cached_at: oldTime, ...oldData} = old;
      const {cached_at: newTime, ...newData} = row;
      return JSON.stringify(oldData) !== JSON.stringify(newData);
    });
    const currentKeys = new Set(rows.map(row => row.match_key));
    const removed = (await db().schedule.where("event_key").equals(eventKey).primaryKeys()).filter(key => !currentKeys.has(String(key)));
    if (removed.length) await db().schedule.bulkDelete(removed as string[]);
    if (!changed.length && !stale.length && !removed.length) return;
    if (changed.length) await db().schedule.bulkPut(changed);
    await db().settings.put({ key: SCHEDULE_EVENT_KEY, value: eventKey });
    await db().settings.put({ key: SCHEDULE_SAVED_KEY, value: String(now) });
  });
}

export async function cachedSchedule(eventKey?: string): Promise<MatchRec[]> {
  const rows = eventKey
    ? await db().schedule.where("event_key").equals(eventKey).toArray()
    : await db().schedule.toArray();
  const order: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
  return rows.sort(
    (a, b) =>
      (order[a.comp_level] ?? 9) - (order[b.comp_level] ?? 9) ||
      a.match_number - b.match_number
  );
}

export async function cachedScheduleInfo(): Promise<{
  event: string;
  savedAt: number | null;
  count: number;
}> {
  const [ev, saved, count] = await Promise.all([
    db().settings.get(SCHEDULE_EVENT_KEY),
    db().settings.get(SCHEDULE_SAVED_KEY),
    db().schedule.count(),
  ]);
  return {
    event: ev?.value || "",
    savedAt: saved ? Number(saved.value) : null,
    count,
  };
}

/** The teams on the field for one match, straight from the offline cache. */
export async function cachedMatch(matchKey: string): Promise<MatchRec | undefined> {
  return db().schedule.get(matchKey);
}

// ---- Device identity + persistent storage (device setup) ------------------
export async function getDeviceId(): Promise<string> {
  const existing = await db().settings.get("deviceId");
  if (existing) return existing.value;
  const id = uuid();
  await db().settings.put({ key: "deviceId", value: id });
  return id;
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
