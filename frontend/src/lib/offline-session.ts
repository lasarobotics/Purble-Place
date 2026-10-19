import type { Session } from "./types";

// Memory only: a local unlock never creates a bearer token or server authority.
let unlocked: Session | null = null;
export function offlineSession(): Session | null {
  if (unlocked && (unlocked.offline_until || 0) <= Date.now()) unlocked = null;
  return unlocked;
}
export function setOfflineSession(value: Session | null) { unlocked = value; }
