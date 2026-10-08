// Offline queue backed by IndexedDB (Dexie). When the network is down the
// scout form writes here; sync.ts flushes to the backend when we're back
// online and deletes the local copy on success.
import Dexie, { Table } from "dexie";
import type { ScoutEntry } from "./types";
import { localOwner } from "./identity";

export interface PendingScout extends ScoutEntry {
  client_uuid: string;
  queued_at: number;
  owner_id?: string;
  last_error?: string;
}

class HazeDB extends Dexie {
  pendingScouts!: Table<PendingScout, string>;
  responses!: Table<{ key: string; json: string; saved_at: number }, string>;

  constructor() {
    super("hazehub");
    this.version(1).stores({
      pendingScouts: "client_uuid, team_number, match_number, queued_at",
    });
    this.version(2).stores({
      pendingScouts: "client_uuid, team_number, match_number, queued_at, owner_id",
      responses: "key, saved_at",
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

export async function queueScout(entry: PendingScout) {
  await db().pendingScouts.put({ ...entry, owner_id: localOwner() });
  window.dispatchEvent(new Event("scout-queue-changed"));
}
export async function pendingScouts(): Promise<PendingScout[]> {
  return db().pendingScouts.where("owner_id").equals(localOwner()).sortBy("queued_at");
}
export async function legacyScouts(): Promise<PendingScout[]> {
  // Older app versions did not record ownership. Require explicit review,
  // rather than silently syncing another person's entries on a shared device.
  return db().pendingScouts.filter(entry => !entry.owner_id).toArray();
}
export async function removePending(uuids: string[]) {
  if (uuids.length) await db().pendingScouts.bulkDelete(uuids);
  window.dispatchEvent(new Event("scout-queue-changed"));
}
export async function pendingCount(): Promise<number> {
  return db().pendingScouts.where("owner_id").equals(localOwner()).count();
}
