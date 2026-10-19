import { authenticate, Env, Fault, identifier, json, privateSnapshot, stagingEvent } from "../shared/core";
import { submit, auditReport } from "./scouting";
import { dispatch, consume } from "./jobs";
import { meeting, ticket } from "./meetings";
import { accountStatus, setup, login, me } from "./auth";
import { scheduleExternalRefresh, eventRatings } from "./external";
import { pageSnapshot, batchPages } from "./pages";
import { syncScout } from "./sync";
export { MeetingRoom } from "./realtime";

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await route(request, env);
    } catch (err) {
      const fault = err instanceof Fault || (err && typeof err === "object" && "status" in err && typeof (err as Fault).status === "number");
      const status = fault ? Number((err as Fault).status) : 503;
      const detail = fault ? String((err as Error).message) : err instanceof Error ? err.message : "Service temporarily unavailable";
      return json({ detail }, status);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    await dispatch(env);
  },
  async queue(batch: MessageBatch<{ id: string }>, env: Env) {
    for (const message of batch.messages) {
      try {
        await consume(env, message.body.id);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, { id: string }>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;

  if (path.startsWith("/api/prototype/ws/")) {
    const id = identifier(path.split("/").pop());
    return env.MEETINGS.get(env.MEETINGS.idFromName(id)).fetch(
      new Request(`https://internal/connect/${id}?ticket=${encodeURIComponent(url.searchParams.get("ticket") || "")}`, request)
    );
  }

  if (path === "/api/auth/account-status" && request.method === "POST") return accountStatus(request, env);
  if (path === "/api/auth/setup" && request.method === "POST") return setup(request, env);
  if (path === "/api/auth/login" && request.method === "POST") return login(request, env);

  const user = await authenticate(request, env);
  if (path === "/api/auth/me" && request.method === "GET") {
    const token =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") ||
      request.headers.get("Cookie")?.match(/(?:^|;\s*)hazehub_session=([^;]+)/)?.[1];
    return me(user, token);
  }

  if (request.method === "GET" && (path === "/api/admin/data-analysis" || path === "/api/prototype/overview")) {
    const event = identifier(url.searchParams.get("event") || env.STAGING_EVENT);
    stagingEvent(event, env);
    return privateSnapshot(request, env, event, path.endsWith("overview") ? "overview" : "analysis");
  }

  if (path.startsWith("/api/prototype/pages/") && request.method === "GET") {
    return pageSnapshot(request, env, identifier(path.split("/").pop()!));
  }
  if (path === "/api/prototype/pages" && request.method === "GET") return batchPages(request, env);

  if (path === "/api/prototype/scout" && request.method === "POST") return submit(request, env, user);
  if (path === "/api/sync/scout" && request.method === "POST") return syncScout(request, env, user);
  if (path.startsWith("/api/prototype/reports/") && request.method === "PATCH") {
    return auditReport(request, env, user, identifier(path.split("/").pop()!));
  }
  if (path === "/api/prototype/reports" && request.method === "GET") {
    const event = identifier(url.searchParams.get("event") || env.STAGING_EVENT);
    stagingEvent(event, env);
    const cursor = url.searchParams.get("cursor") || "";
    const rows = await env.DB.prepare(
      "SELECT id,team,match_number,payload,voided,version FROM reports WHERE event_id=? AND id>? ORDER BY id LIMIT 50"
    ).bind(event, cursor).all<any>();
    return json({
      reports: rows.results.map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
      next_cursor: rows.results.length === 50 ? rows.results.at(-1)!.id : null,
    });
  }

  if (path.startsWith("/api/prototype/meetings/")) return meeting(request, env, user, identifier(path.split("/").pop()!));
  if (path === "/api/prototype/tickets" && request.method === "POST") return ticket(request, env, user);
  if (path === "/api/prototype/external/refresh" && request.method === "POST") return scheduleExternalRefresh(request, env, user);
  if (path === "/api/matches/event-ratings" && request.method === "GET") return eventRatings(request, env);

  return json({ detail: "Not migrated; use the existing Render backend" }, 501);
}
