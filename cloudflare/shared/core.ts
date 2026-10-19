export interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
  STAGING_EVENT: string;
  DOMAIN: Fetcher;
  ASSETS?: Fetcher;
  JOBS: Queue<{ id: string }>;
  MEETINGS: DurableObjectNamespace;
  LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Optional shared Admin bootstrap password (staging only). */
  TEAM_PASSWORD?: string;
  TBA_AUTH_KEY?: string;
  TBA_BASE?: string;
  MATCH13_API_KEY?: string;
  MATCH13_BASE?: string;
}
export type Principal = { id: string; display_name: string; role: string; credential_revision: string; s_number: number; exp: number };
export class Fault extends Error { constructor(public status: number, message: string) { super(message); } }
export const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
export const now = () => Date.now();
export function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export async function digest(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2,"0")).join("");
}
export async function readBody(request: Request, max = 65536): Promise<any> {
  if (!request.body) throw new Fault(400, "JSON body required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > max) { await reader.cancel(); throw new Fault(413, "Request too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Fault(400,"Invalid JSON"); }
}
export function identifier(v: unknown): string {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v)) throw new Fault(400,"Invalid identifier");
  return v;
}
function decode(v: string) { return Uint8Array.from(atob(v.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0)); }
export async function authenticate(request: Request, env: Env): Promise<Principal> {
  if (!env.SESSION_SECRET) throw new Fault(503,"Authentication is not configured");
  let token = request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
  if (!token && new URL(request.url).pathname === "/api/auth/me" && request.method === "GET")
    token = request.headers.get("Cookie")?.match(/(?:^|;\s*)hazehub_session=([^;]+)/)?.[1] || "";
  let body: any;
  try {
    if (token.length > 4096) throw new Error();
    const [raw, signature, extra] = token.split("."); if (extra || !raw || !signature) throw new Error();
    const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(env.SESSION_SECRET),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
    if (!await crypto.subtle.verify("HMAC",key,decode(signature),new TextEncoder().encode(raw))) throw new Error();
    body = JSON.parse(new TextDecoder().decode(decode(raw)));
    if (body.auth_version !== 2 || !Number.isFinite(body.exp) || body.exp * 1000 <= now() || typeof body.sub !== "string") throw new Error();
  } catch { throw new Fault(401,"Not signed in"); }
  // Always revalidate current status; process memory is never authoritative.
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=? AND active=1").bind(body.sub).first<any>();
  if (!account || account.credential_revision !== body.credential_revision) throw new Fault(401,"Credentials revoked or changed");
  return { ...account, exp: body.exp };
}
export function admin(p: Principal) { if (p.id !== "Admin" || p.role !== "admin") throw new Fault(403,"Admin only"); }
export function stagingEvent(event: string, env: Env) {
  if (!env.STAGING_EVENT || event !== env.STAGING_EVENT || !event.startsWith("prototype-")) throw new Fault(403,"Only the isolated prototype event is enabled");
}
export async function privateSnapshot(request: Request, env: Env, event: string, kind: string) {
  const row = await env.DB.prepare("SELECT s.*, e.revision AS current_revision FROM snapshots s JOIN event_revisions e ON e.event_id=s.event_id WHERE s.event_id=? AND s.kind=?").bind(event,kind).first<any>();
  if (!row) return json({ detail:"Snapshot pending", pending:true },202,{"Retry-After":"30"});
  const tag = `"${kind}-${row.revision}-${row.digest}"`;
  const headers = { ETag:tag,"Cache-Control":"private, no-cache",Vary:"Authorization, Cookie","X-Haze-Revision":String(row.revision),"X-Haze-Stale":String(row.revision !== row.current_revision) };
  if (request.headers.get("If-None-Match")?.split(",").map(s=>s.trim().replace(/^W\//,"")).includes(tag)) return new Response(null,{status:304,headers});
  return new Response(row.body,{headers:{...headers,"Content-Type":"application/json"}});
}
