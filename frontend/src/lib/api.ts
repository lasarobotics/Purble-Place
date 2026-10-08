// Central API client. Resolves the backend base URL with a sensible local
// default and auto-detects a same-origin deployment.
import { db } from "./db";
import { localOwner, localAdmin } from "./identity";
import { isAnalysisPath, selectAnalysis } from "./analysis";

const inFlight = new Map<string, Promise<any>>();
let analysisGeneration = 0;
const analyses = new Map<string, { generation: number; loaded: number; promise: Promise<any> }>();
export function invalidateAnalysis() { analysisGeneration++; }

//: Ports the Next.js dev server runs on. Only on these is the API somewhere
//: other than the page's own origin.
const DEV_SERVER_PORTS = ["3000", "3001"];

export function apiBase(): string {
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
  return "http://localhost:8000";
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
  return "ws://localhost:8000/ws";
}

const TOKEN_KEY = "hazehub.token";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(TOKEN_KEY) || "";
}
export function setToken(t: string) {
  if (typeof window !== "undefined") window.localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  if (typeof window !== "undefined") window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T = any>(
  path: string,
  opts: { method?: string; body?: any; auth?: boolean } = {}
): Promise<T> {
  const { method = "GET", body, auth = true } = opts;
  const generationAtStart = analysisGeneration;
  const cacheable = (method === "GET" && !path.startsWith("/api/events")) || (method === "POST" && path === "/api/teams/batch");
  const key = `${apiBase()}|${auth ? localOwner() : "public"}|${path}${method === "POST" ? `|${JSON.stringify(body)}` : ""}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    const t = getToken();
    if (t) headers["Authorization"] = `Bearer ${t}`;
  }
  let res: Response;
  try {
    if (typeof navigator !== "undefined" && !navigator.onLine) throw new TypeError("Offline");
    res = await fetch(`${apiBase()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 500) throw new ApiError(res.status, "Server unavailable");
  } catch (err) {
    if (cacheable) {
      const cached = await db().responses.get(key).catch(() => undefined);
      if (cached) {
        window.dispatchEvent(new CustomEvent("offline-snapshot", { detail: cached.saved_at }));
        return JSON.parse(cached.json) as T;
      }
    }
    throw err;
  }
  if (!res.ok) {
    if (res.status === 401 && auth && typeof window !== "undefined") window.dispatchEvent(new Event("auth-expired"));
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
      if (previous?.json !== json) await db().responses.put({ key, json, saved_at: Date.now() });
    } catch { /* A cache failure must not hide a successful cloud response. */ }
  }
  return result as T;
}

export function api<T = any>(path: string, opts: { method?: string; body?: any; auth?: boolean } = {}): Promise<T> {
  // This POST is a read-only lookup. Reuse the cloud snapshot for admin views.
  if (path === "/api/teams/batch" && localAdmin() && opts.method === "POST") {
    return api<any>("/api/admin/event-teams").then(async () => {
      const bundle = await analyses.get(`${getToken()}|current`)!.promise;
      const wanted = new Set(opts.body?.teams || []);
      return (bundle.profiles || []).filter((t: any) => wanted.has(t.team_number)) as T;
    });
  }
  if (opts.method && opts.method !== "GET") return request<T>(path, opts);
  if (isAnalysisPath(path)) {
    const event = new URL(path, "http://local").searchParams.get("event");
    const key = `${getToken()}|${event || "current"}`;
    let bundle = analyses.get(key);
    if (!bundle || bundle.generation !== analysisGeneration || Date.now() - bundle.loaded > 30000) {
      const promise = request<any>(`/api/admin/analysis${event ? `?event=${encodeURIComponent(event)}` : ""}`)
        .catch(error => { analyses.delete(key); throw error; });
      bundle = { generation: analysisGeneration, loaded: Date.now(), promise };
      analyses.set(key, bundle);
    }
    const generation = bundle.generation;
    return bundle.promise.then(data => generation === analysisGeneration ? selectAnalysis(data, path) : api<T>(path, opts));
  }
  const key = `${getToken()}|${path}|${opts.auth !== false}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = request<T>(path, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
