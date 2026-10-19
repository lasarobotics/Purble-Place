// Central API client. Resolves the backend base URL with a sensible local
// default and auto-detects a same-origin deployment.
import { db } from "./db";
import { localOwner } from "./identity";
import { offlineSession } from "./offline-session";
import { sessionToken, saveSessionToken } from "./session-token";

const inFlight = new Map<string, Promise<any>>();
let analysisGeneration = 0;
export function invalidateAnalysis() { analysisGeneration++; }

//: Ports the Next.js dev server runs on. Only on these is the API somewhere
//: other than the page's own origin.
const DEV_SERVER_PORTS = ["3000", "3001"];

export function apiBase(): string {
  // Public deployments always use the same-origin gateway, even when a build
  // accidentally inherits a developer's localhost NEXT_PUBLIC_API_URL.
  if (typeof window !== "undefined" && !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) return "";
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env && env.trim()) return env.trim().replace(/\/$/, "");
  if (typeof window !== "undefined") {
    // In every deployment the API serves this page: one process on the
    // scouting laptop, or the container on Render. Same origin is therefore
    // the right default whatever the hostname is, including localhost on a
    // non-default port. Keying off the hostname instead used to send
    // `run-server.ps1 -Port 8080` to localhost:8000 and fail every request.
    if (!DEV_SERVER_PORTS.includes(window.location.port)) return "";
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return "";
}

// WebSocket URL for the realtime hub (/ws). Derives ws/wss from the
// API base, or from the current origin for same-origin (Nginx) deployments.
export function wsUrl(): string {
  const base = apiBase();
  if (base.startsWith("http")) return base.replace(/^http/, "ws") + "/ws";
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws`;
  }
  return "/ws";
}

const TOKEN_KEY = "hazehub.token";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  const token = sessionToken();
  try {
    const body = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
    if (body.auth_version === 2 && body.exp > Date.now() / 1000) return token;
  } catch {}
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem("hazehub.session");
  saveSessionToken("");
  return "";
}
export function setToken(t: string) {
  if (typeof window !== "undefined") saveSessionToken(t);
}
export function clearToken() {
  if (typeof window !== "undefined") { saveSessionToken(""); window.localStorage.removeItem(TOKEN_KEY); }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const authChecks = new Map<string, Promise<boolean>>();
async function recoverSession(rejectedToken: string): Promise<boolean> {
  const pending = authChecks.get(rejectedToken);
  if (pending) return pending;
  const check = (async () => {
    const res = await fetch(`${apiBase()}/api/auth/me`, {
      credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000),
      headers: rejectedToken ? { Authorization: `Bearer ${rejectedToken}` } : {},
    });
    if (rejectedToken !== getToken() || offlineSession()) return false;
    if (res.status === 401) {
      window.dispatchEvent(new Event("auth-expired"));
      return false;
    }
    if (!res.ok) return false; // Timeouts, outages and permission errors are not sign-outs.
    const session = await res.json();
    if (rejectedToken !== getToken() || offlineSession() || sessionStorage.getItem("hazehub.offline-reauth") === "1") return false;
    if (!session.token || (localOwner() && session.scout_id !== localOwner())) return false;
    setToken(session.token);
    window.dispatchEvent(new CustomEvent("auth-restored", { detail: session }));
    return true;
  })().catch(() => false).finally(() => authChecks.delete(rejectedToken));
  authChecks.set(rejectedToken, check);
  return check;
}

async function request<T = any>(
  path: string,
  opts: { method?: string; body?: any; auth?: boolean } = {},
  retriedAuth = false,
): Promise<T> {
  const { method = "GET", body, auth = true } = opts;
  const generationAtStart = analysisGeneration;
  const cacheable = (method === "GET" && !path.startsWith("/api/auth/") && !path.startsWith("/api/events")) || (method === "POST" && path === "/api/teams/batch");
  const key = `${apiBase()}|${auth ? localOwner() : "public"}|${path}${method === "POST" ? `|${JSON.stringify(body)}` : ""}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const requestToken = auth ? getToken() : "";
  const previous = cacheable ? await db().responses.get(key).catch(() => undefined) : undefined;
  if (previous?.etag && method === "GET") headers["If-None-Match"] = previous.etag;
  if (auth) {
    const t = requestToken;
    if (t) headers["Authorization"] = `Bearer ${t}`;
  }
  const owner = auth ? localOwner() || "anon" : "public";
  let priorEtag: string | undefined;
  if (cacheable && method === "GET") {
    try {
      const snap = await db().snapshots.get(key);
      if (snap?.etag) {
        priorEtag = snap.etag;
        headers["If-None-Match"] = snap.etag;
      }
    } catch { /* offline cache miss is fine */ }
  }
  let res: Response;
  try {
    if (auth && offlineSession()) throw new ApiError(401, "Sign in online again before synchronizing or making server changes.");
    if (typeof navigator !== "undefined" && !navigator.onLine) throw new TypeError("Offline");
    res = await fetch(`${apiBase()}${path}`, {
    credentials: "include",
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 500) throw new ApiError(res.status, "Server unavailable");
  } catch (err) {
    if (cacheable) {
      const cached =
        (await db().snapshots.get(key).catch(() => undefined)) ||
        (await db().responses.get(key).catch(() => undefined));
      if (cached) {
        window.dispatchEvent(new CustomEvent("offline-snapshot", { detail: cached.saved_at }));
        return JSON.parse(cached.json) as T;
      }
    }
    throw err;
  }
  if (res.status === 304 && cacheable) {
    const cached = await db().snapshots.get(key).catch(() => undefined);
    if (cached) return JSON.parse(cached.json) as T;
    if (priorEtag) {
      const legacy = await db().responses.get(key).catch(() => undefined);
      if (legacy) return JSON.parse(legacy.json) as T;
    }
  }
  if (res.status === 304 && previous) return JSON.parse(previous.json) as T;
  if (!res.ok) {
    if (res.status === 401 && auth && requestToken === getToken() && typeof window !== "undefined") {
      if (path === "/api/auth/me") window.dispatchEvent(new Event("auth-expired"));
      else if (!retriedAuth && await recoverSession(requestToken) && method === "GET") return request<T>(path, opts, true);
    }
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail || detail;
    } catch {}
    throw new ApiError(res.status, typeof detail === "string" ? detail : "Request failed");
  }
  if (res.status === 204) return undefined as T;
  const result = await res.json();
  if (cacheable && (!path.startsWith("/api/admin/analysis") || generationAtStart === analysisGeneration)) {
    const json = JSON.stringify(result);
    // Do not rewrite identical snapshots on every refresh.
    try {
      const previous = await db().responses.get(key);
      const etag = res.headers.get("ETag") || undefined;
      if (requestToken !== getToken() && auth) return result as T;
      if (previous?.json !== json || previous?.etag !== etag) {
        await db().responses.put({ key, json, saved_at: Date.now(), etag });
        const count = await db().responses.count();
        if (count > 300) {
          const stale = await db().responses.orderBy("saved_at").limit(count - 300).primaryKeys();
          await db().responses.bulkDelete(stale);
        }
      }
      const revision = res.headers.get("X-Haze-Revision") || undefined;
      await db().snapshots.put({ key, owner_id: owner, json, etag, revision, saved_at: Date.now() });
      const snapCount = await db().snapshots.count();
      if (snapCount > 200) {
        const staleSnaps = await db().snapshots.orderBy("saved_at").limit(snapCount - 200).primaryKeys();
        await db().snapshots.bulkDelete(staleSnaps);
      }
    } catch { /* A cache failure must not hide a successful cloud response. */ }
  }
  return result as T;
}

export function api<T = any>(path: string, opts: { method?: string; body?: any; auth?: boolean } = {}): Promise<T> {
  if (opts.method && opts.method !== "GET") return request<T>(path, opts);
  const key = `${getToken()}|${localOwner()}|${path}|${opts.auth !== false}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = request<T>(path, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
