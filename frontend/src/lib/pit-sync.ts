import { api, ApiError, getToken } from "./api";
import { db, pendingPits } from "./db";

let syncing = false;

export async function flushPitQueue(): Promise<{ synced: number; remaining: number }> {
  if (!getToken() || syncing || (typeof navigator !== "undefined" && !navigator.onLine)) {
    return { synced: 0, remaining: (await pendingPits()).length };
  }
  syncing = true;
  let synced = 0;
  try {
    const pending = await pendingPits();
    if (!pending.length) return { synced: 0, remaining: 0 };
    try { await api("/api/auth/me"); }
    catch { return { synced: 0, remaining: (await pendingPits()).length }; }
    for (const row of pending.slice(0, 20)) {
      await db().pendingPits.update(row.id, { sync_status: "sending" });
      try {
        await api("/api/pit", { method: "POST", body: row.body });
        await db().pendingPits.update(row.id, {
          sync_status: "acknowledged", last_error: null, updated_at: Date.now(),
        });
        synced++;
      } catch (error: any) {
        const invalid = error instanceof ApiError && [400, 422].includes(error.status);
        await db().pendingPits.update(row.id, {
          sync_status: invalid ? "invalid" : "retry_wait",
          last_error: error?.message || "Could not sync pit report",
          updated_at: Date.now(),
        });
      }
    }
  } finally {
    syncing = false;
    window.dispatchEvent(new Event("pit-queue-changed"));
  }
  return { synced, remaining: (await pendingPits()).length };
}
