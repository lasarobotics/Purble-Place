// Synchronization engine, drives queued IndexedDB submissions to the cloud.
//
// State machine per record (see db.ts SyncStatus):
//   queued → sending → acknowledged            (200/201, or already_exists)
//                    → retry_wait              (timeout / 429 / 5xx, backoff+jitter)
//                    → invalid                 (400/422, needs correction)
//                    → conflict                (409. UUID reused, different payload)
//                    → auth_required           (401/403)
// Nothing is ever deleted because a sync failed.
import { localOwner } from "./identity";
import { emitBus } from "./bus";
import { api, ApiError, getToken } from "./api";
import { markAcknowledged, markRetry, markStatus, pendingCount, pendingScouts, type PendingScout } from "./db";

let syncing = false;

// ---- Canonical payload hash ------------------------------------------------
// Must mirror the server's canonical_hash: the same field subset, sorted keys,
// compact separators, null for missing values.
const HASHED_FIELDS = [
  "event_key", "match_number", "comp_level", "team_number", "alliance",
  "station", "heatmap", "auto_leave", "auto_climb", "climb", "climb_seconds",
  "tags", "played_defense", "defense_rating", "defense_on",
  "successful_stops", "driver_skill", "speed_rating", "fouls",
  "failure", "failure_details", "no_show", "notes",
] as const;

function canonicalJson(value: any): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export async function payloadHash(entry: Record<string, any>): Promise<string> {
  const subset: Record<string, any> = {};
  for (const k of HASHED_FIELDS) subset[k] = entry[k] ?? null;
  for (const k of ["auto_missed", "teleop_missed"]) {
    if (entry[k]) subset[k] = entry[k];
  }
  const canonical = canonicalJson(subset);
  try {
    const bytes = new TextEncoder().encode(canonical);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return ""; // no SubtleCrypto (http on LAN), server computes the hash
  }
}

// ---- Retry policy ----------------------------------------------------------
function retryDelay(attemptCount: number): number {
  const base = Math.min(60_000, 2_000 * 2 ** attemptCount);
  const jitter = Math.floor(Math.random() * 2_000);
  return base + jitter;
}

interface BatchResult {
  submission_id: string;
  status: "created" | "already_exists" | "conflict" | "invalid" | "retry";
  error?: string;
}

/** Flush due queued entries to the cloud in one batch. */
export async function flushQueue(): Promise<{ synced: number; remaining: number }> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("hazehub-sync", {ifAvailable: true}, async lock => lock ? flushOwnedQueue() : {synced: 0, remaining: await pendingCount()});
  }
  return flushOwnedQueue();
}
async function flushOwnedQueue(): Promise<{ synced: number; remaining: number }> {
  if (!getToken()) return { synced: 0, remaining: await pendingCount() };
  if (syncing) return { synced: 0, remaining: await pendingCount() };
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { synced: 0, remaining: await pendingCount() };
  }
  syncing = true;
  try {
    const now = Date.now();
    const due = (await pendingScouts()).filter(
      (r) => !r.next_attempt_at || r.next_attempt_at <= now
    ).slice(0, 50);
    if (!due.length) return { synced: 0, remaining: await pendingCount() };
    // Never trust an offline snapshot for credentials, roster membership or role.
    try { await api("/api/auth/me"); }
    catch { return { synced: 0, remaining: await pendingCount() }; }

    for (const r of due) await markStatus(r.client_uuid, "sending");
    const entries = due.map(({ owner_id, queued_at, sync_status, attempt_count, last_attempt_at, next_attempt_at, last_error, azure_received_at, ...rest }) => rest);

    let res: { results?: BatchResult[]; accepted?: string[]; duplicates?: string[] };
    try {
      res = await api("/api/sync/scout", { method: "POST", body: { entries } });
    } catch (err: any) {
      // Whole-batch failure: auth problems park the queue; anything else backs
      // every record off for a later retry.
      const auth = err instanceof ApiError && (err.status === 401 || err.status === 403);
      for (const r of due) {
        const attempts = (r.attempt_count ?? 0) + 1;
        if (auth) await markStatus(r.client_uuid, "auth_required", "Sign in again to sync");
        else await markRetry(r.client_uuid, attempts, Date.now() + retryDelay(attempts), err?.message);
      }
      return { synced: 0, remaining: await pendingCount() };
    }

    let synced = 0;
    if (res.results?.length) {
      for (let i = 0; i < due.length; i++) {
        const r = due[i];
        const result = res.results.find(item => item.submission_id === (r.submission_id || r.client_uuid));
        if (!result) {
          await markStatus(r.client_uuid, "queued");
          continue;
        }
        if (result.status === "created" || result.status === "already_exists") {
          await markAcknowledged([r.client_uuid]);
          if (result.status === "created") synced++;
        } else if (result.status === "conflict") {
          await markStatus(r.client_uuid, "conflict", result.error);
        } else if (result.status === "retry") {
          const attempts = (r.attempt_count ?? 0) + 1;
          await markRetry(r.client_uuid, attempts, Date.now() + retryDelay(attempts), result.error);
        } else {
          await markStatus(r.client_uuid, "invalid", result.error);
        }
      }
    } else {
      // Older server shape: accepted/duplicates arrays only.
      const done = [...(res.accepted || []), ...(res.duplicates || [])].filter(Boolean);
      await markAcknowledged(done);
      for (const r of due) {
        if (!done.includes(r.client_uuid)) await markStatus(r.client_uuid, "queued");
      }
      synced = (res.accepted || []).length;
    }
    if (synced) emitBus("scout_submitted", { synced });
    return { synced, remaining: await pendingCount() };
  } catch {
    return { synced: 0, remaining: await pendingCount() };
  } finally {
    syncing = false;
  }
}

/** Manual "Retry now": clear backoff timers and flush immediately. */
export async function retryNow(): Promise<{ synced: number; remaining: number }> {
  const rows = (await allLocalScouts()).filter(r => r.owner_id === localOwner());
  for (const r of rows) {
    if (r.sync_status === "retry_wait" || r.sync_status === "auth_required") {
      await markStatus(r.client_uuid, "queued");
      await db().pendingScouts.update(r.client_uuid, {next_attempt_at: null});
    }
  }
  return flushQueue();
}

// ---- JSONL recovery export / import ---------------------------------------
import { allLocalScouts, queueScout, uuid, db } from "./db";

export async function exportJSONL(onlyQueued = false): Promise<{ text: string; count: number }> {
  const rows = await allLocalScouts();
  const subset = onlyQueued
    ? rows.filter((r) => r.sync_status !== "acknowledged")
    : rows;
  const lines = subset.map((r) =>
    JSON.stringify({
      submission_id: r.submission_id || r.client_uuid,
      client_uuid: r.client_uuid,
      payload_hash: r.payload_hash || "",
      event_key: r.event_key,
      match_number: r.match_number,
      comp_level: r.comp_level,
      team_number: r.team_number,
      alliance: r.alliance,
      station: r.station,
      sync_status: r.sync_status || "queued",
      client_ts: r.client_ts || null,
      entry: r,
    })
  );
  return { text: lines.join("\n") + (lines.length ? "\n" : ""), count: lines.length };
}

/** Import a recovery JSONL from another device; records enter the queue and
 *  sync through the same idempotent batch endpoint (UUIDs dedupe server-side). */
export async function importJSONL(text: string): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      const entry = parsed.entry || parsed;
      const id = parsed.submission_id || entry.submission_id || entry.client_uuid || uuid();
      await queueScout({
        ...entry,
        client_uuid: id,
        submission_id: id,
        payload_hash: parsed.payload_hash || entry.payload_hash || "",
        queued_at: entry.queued_at || Date.now(),
        sync_status: "queued",
        attempt_count: 0,
        next_attempt_at: null,
      });
      imported++;
    } catch {
      skipped++;
    }
  }
  if (imported) void flushQueue();
  return { imported, skipped };
}
