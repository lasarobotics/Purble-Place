// Flush queued offline scouting entries to the backend.
import { api } from "./api";
import { db, pendingScouts, removePending, pendingCount } from "./db";
import { emitBus } from "./bus";

let syncing = false;

async function runFlushQueue(): Promise<{ synced: number; remaining: number }> {
  if (syncing) return { synced: 0, remaining: await pendingCount() };
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { synced: 0, remaining: await pendingCount() };
  }
  syncing = true;
  try {
    const queued = (await pendingScouts()).filter(entry => !entry.last_error).slice(0, 100);
    if (!queued.length) return { synced: 0, remaining: await pendingCount() };
    const entries = queued.map(({ queued_at, owner_id, last_error, ...rest }) => rest);
    const res = await api<{ accepted: string[]; duplicates: string[]; rejected?: Record<string, string> }>("/api/sync/scout", {
      method: "POST",
      body: { entries },
    });
    const done = [...(res.accepted || []), ...(res.duplicates || [])];
    await db().transaction("rw", db().pendingScouts, async () => {
      for (const [id, message] of Object.entries(res.rejected || {})) {
        await db().pendingScouts.update(id, { last_error: message });
      }
    });
    await removePending(done.filter(Boolean));
    if (done.length) emitBus("scout_submitted", { synced: done.length });
    return { synced: (res.accepted || []).length, remaining: await pendingCount() };
  } catch {
    return { synced: 0, remaining: await pendingCount() };
  } finally {
    syncing = false;
  }
}

export async function flushQueue(): Promise<{ synced: number; remaining: number }> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("hazehub-scout-sync", { ifAvailable: true }, async lock =>
      lock ? runFlushQueue() : { synced: 0, remaining: await pendingCount() });
  }
  return runFlushQueue();
}
