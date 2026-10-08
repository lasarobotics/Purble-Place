// Central API client. Resolves the backend base URL with a sensible local
// default and auto-detects a same-origin deployment.
import { db } from "./db";
import { localOwner, localAdmin } from "./identity";
import { isAnalysisPath, selectAnalysis } from "./analysis";

const inFlight = new Map<string, Promise<any>>();
let analysisGeneration = 0;
const analyses = new Map<string, { generation: number; loaded: number; promise: Promise<any> }>();
export function invalidateAnalysis() { analysisGeneration++; }

export function apiBase(): string {
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env && env.trim()) return env.trim().replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    // Deployed somewhere that proxies /api to the backend on the same origin.
    if (h !== "localhost" && h !== "127.0.0.1") return "";
  }
  return "http://localhost:8000";
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
