/**
 * External Match13 / TBA fetches with durable D1 cache.
 * Credentials never leave the Worker. Results are queued, not request-path blocking.
 */
import { canonical, digest, Env, Fault, json, now, Principal, readBody, stagingEvent, identifier, admin } from "../shared/core";

async function cachedGet(env: Env, key: string, ttlMs: number, fetcher: () => Promise<unknown>) {
  const hit = await env.DB.prepare("SELECT body,expires_at FROM external_cache WHERE cache_key=?").bind(key).first<any>();
  if (hit && hit.expires_at > now()) return JSON.parse(hit.body);
  const data = await fetcher();
  const body = canonical(data);
  const hash = await digest(body);
  await env.DB.prepare(
    `INSERT INTO external_cache(cache_key,body,digest,fetched_at,expires_at) VALUES(?,?,?,?,?)
     ON CONFLICT(cache_key) DO UPDATE SET body=excluded.body,digest=excluded.digest,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at`
  ).bind(key, body, hash, now(), now() + ttlMs).run();
  return data;
}

export async function refreshExternal(env: Env, eventId: string, payload: { sources?: string[] }) {
  const sources = payload.sources || ["tba", "match13"];
  const tbaBase = (env.TBA_BASE || "https://www.thebluealliance.com/api/v3").replace(/\/$/, "");
  const match13Base = (env.MATCH13_BASE || "https://actions.match13.com").replace(/\/$/, "");
  if (sources.includes("tba") && env.TBA_AUTH_KEY) {
    await cachedGet(env, `tba:event:${eventId}`, 900_000, async () => {
      const res = await fetch(`${tbaBase}/event/${eventId}`, {
        headers: { "X-TBA-Auth-Key": env.TBA_AUTH_KEY!, "User-Agent": "HazeHub/cloudflare-staging" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`TBA ${res.status}`);
      return res.json();
    });
  }
  if (sources.includes("match13") && env.MATCH13_API_KEY) {
    await cachedGet(env, `match13:ratings:${eventId}`, 300_000, async () => {
      const res = await fetch(`${match13Base}/v1/events/${eventId}/teams`, {
        headers: { accept: "application/json", Authorization: `Bearer ${env.MATCH13_API_KEY}`, "User-Agent": "HazeHub/cloudflare-staging" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Match13 ${res.status}`);
      return res.json();
    });
  }
}

export async function scheduleExternalRefresh(request: Request, env: Env, user: Principal) {
  admin(user);
  const body = await readBody(request, 2048);
  const event = identifier(body.event_key || env.STAGING_EVENT);
  stagingEvent(event, env);
  const id = `external:${event}`;
  await env.DB.prepare(
    `INSERT INTO jobs(id,type,event_id,idempotency_key,payload,created_at,expires_at,priority)
     VALUES(?,?,?,?,?,?,?,5)
     ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=0,next_attempt_at=0,payload=excluded.payload,expires_at=excluded.expires_at`
  ).bind(id, "external", event, id, JSON.stringify({ sources: body.sources || ["tba", "match13"] }), now(), now() + 86_400_000).run();
  try { await env.JOBS.send({ id }); } catch { /* cron recovers */ }
  return json({ queued: true, job_id: id });
}

export async function eventRatings(request: Request, env: Env) {
  const url = new URL(request.url);
  const event = identifier(url.searchParams.get("event") || env.STAGING_EVENT);
  stagingEvent(event, env);
  const row = await env.DB.prepare("SELECT body,expires_at FROM external_cache WHERE cache_key=?")
    .bind(`match13:ratings:${event}`).first<any>();
  if (!row) return json({ detail: "Ratings pending", pending: true }, 202, { "Retry-After": "30" });
  return new Response(row.body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-cache",
      "X-Haze-Expires": String(row.expires_at),
    },
  });
}

export async function readCache(env: Env, key: string) {
  const row = await env.DB.prepare("SELECT body FROM external_cache WHERE cache_key=? AND expires_at>?").bind(key, now()).first<any>();
  if (!row) throw new Fault(404, "Cache miss");
  return JSON.parse(row.body);
}
