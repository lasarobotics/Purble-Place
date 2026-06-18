// Offline queue backed by IndexedDB (Dexie). When the network is down the
// scout form writes here; sync.ts flushes to the backend when we're back
// online and deletes the local copy on success.
import Dexie, { Table } from "dexie";
import type { ScoutEntry } from "./types";

export interface PendingScout extends ScoutEntry {
  client_uuid: string;
  queued_at: number;
}

class HazeDB extends Dexie {
  pendingScouts!: Table<PendingScout, string>;

  constructor() {
    super("hazehub");
    this.version(1).stores({
      pendingScouts: "client_uuid, team_number, match_number, queued_at",
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
  await db().pendingScouts.put(entry);
}
export async function pendingScouts(): Promise<PendingScout[]> {
  return db().pendingScouts.orderBy("queued_at").toArray();
}
export async function removePending(uuids: string[]) {
  if (uuids.length) await db().pendingScouts.bulkDelete(uuids);
}
export async function pendingCount(): Promise<number> {
  return db().pendingScouts.count();
}
