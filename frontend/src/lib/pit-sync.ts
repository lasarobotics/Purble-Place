import { api, ApiError } from "./api";
import { db, pendingPits } from "./db";

let syncing = false;

export async function flushPitQueue(): Promise<{ synced: number; remaining: number }> {
  if (syncing || (typeof navigator !== "undefined" && !navigator.onLine)) {
    return { synced: 0, remaining: (await pendingPits()).length };
  }
  syncing = true;
  let synced = 0;
  try {
    for (const row of await pendingPits()) {
      await db().pendingPits.update(row.id, { sync_status: "sending" });
      try {
        await api("/api/pit", { method: "POST", body: row.body });
        await db().pendingPits.update(row.id, {
          sync_status: "acknowledged", last_error: null, updated_at: Date.now(),
        });
        synced++;
      } catch (error: any) {
        const invalid = error instanceof ApiError && error.status >= 400 && error.status < 500;
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
