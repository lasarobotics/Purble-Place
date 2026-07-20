// Central API client. Resolves the backend base URL with a sensible local
// default and auto-detects a same-origin deployment.

export function apiBase(): string {
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env && env.trim()) return env.trim().replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    // Deployed somewhere that proxies /api to the backend on the same origin
    // (MegaScout behind Nginx, Azure, etc.).
    if (h !== "localhost" && h !== "127.0.0.1") return "";
  }
  return "http://localhost:8000";
}

// WebSocket URL for the MegaScout realtime hub (/ws). Derives ws/wss from the
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

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: any; auth?: boolean } = {}
): Promise<T> {
  const { method = "GET", body, auth = true } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    const t = getToken();
    if (t) headers["Authorization"] = `Bearer ${t}`;
  }
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail || detail;
    } catch {}
    throw new ApiError(res.status, typeof detail === "string" ? detail : "Request failed");
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
