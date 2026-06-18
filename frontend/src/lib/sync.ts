// Flush queued offline scouting entries to the backend.
import { api } from "./api";
import { pendingScouts, removePending, pendingCount } from "./db";

let syncing = false;

export async function flushQueue(): Promise<{ synced: number; remaining: number }> {
  if (syncing) return { synced: 0, remaining: await pendingCount() };
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { synced: 0, remaining: await pendingCount() };
  }
  syncing = true;
  try {
    const queued = await pendingScouts();
    if (!queued.length) return { synced: 0, remaining: 0 };
    const entries = queued.map(({ queued_at, ...rest }) => rest);
    const res = await api<{ accepted: string[]; duplicates: string[] }>("/api/sync/scout", {
      method: "POST",
      body: { entries },
    });
    const done = [...(res.accepted || []), ...(res.duplicates || [])];
    await removePending(done.filter(Boolean));
    return { synced: (res.accepted || []).length, remaining: await pendingCount() };
  } catch {
    return { synced: 0, remaining: await pendingCount() };
  } finally {
    syncing = false;
  }
}
