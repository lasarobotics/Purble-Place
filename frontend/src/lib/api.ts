// Central API client. Resolves the backend base URL with a sensible local
// default and auto-detects a same-origin deployment.

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
