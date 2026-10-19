// Local partition key only; the server still verifies every authenticated request.
import { offlineSession } from "./offline-session";
import { sessionToken } from "./session-token";
export function localOwner(): string {
  if (typeof window === "undefined") return "";
  const offline = offlineSession();
  if (offline) return offline.scout_id;
  try {
    const raw = sessionToken().split(".")[0];
    return JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))).sub || "";
  } catch { return ""; }
}

export function localAdmin(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = sessionToken().split(".")[0];
    return JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))).admin === true;
  } catch { return false; }
}
