import { Env, Fault, identifier, json, stagingEvent } from "../shared/core";

const PAGES = new Set(["home", "rankings", "data-analysis", "teams", "picklist", "meeting"]);

/** Aggregated page snapshot — one request per screen, ETag/304 aware. */
export async function pageSnapshot(request: Request, env: Env, page: string) {
  if (!PAGES.has(page)) throw new Fault(404, "Unknown page snapshot");
  const url = new URL(request.url);
  const event = identifier(url.searchParams.get("event") || env.STAGING_EVENT);
  stagingEvent(event, env);

  const row = await env.DB.prepare(
    `SELECT p.*, e.revision AS current_revision FROM page_snapshots p
     JOIN event_revisions e ON e.event_id=p.event_id
     WHERE p.event_id=? AND p.page=?`
  ).bind(event, page).first<any>();

  if (!row) {
    // Fall back to analysis/overview snapshots for early prototype pages.
    if (page === "data-analysis" || page === "home") {
      const kind = page === "home" ? "overview" : "analysis";
      const snap = await env.DB.prepare(
        `SELECT s.*, e.revision AS current_revision FROM snapshots s
         JOIN event_revisions e ON e.event_id=s.event_id WHERE s.event_id=? AND s.kind=?`
      ).bind(event, kind).first<any>();
      if (!snap) return json({ detail: "Snapshot pending", pending: true, page }, 202, { "Retry-After": "30" });
      return etagResponse(request, page, snap);
    }
    return json({ detail: "Snapshot pending", pending: true, page }, 202, { "Retry-After": "30" });
  }
  return etagResponse(request, page, row);
}

function etagResponse(request: Request, page: string, row: any) {
  const tag = `"${page}-${row.revision}-${row.digest}"`;
  const headers: Record<string, string> = {
    ETag: tag,
    "Cache-Control": "private, no-cache",
    Vary: "Authorization, Cookie",
    "X-Haze-Revision": String(row.revision),
    "X-Haze-Stale": String(row.revision !== row.current_revision),
    "Content-Type": "application/json",
  };
  if (request.headers.get("If-None-Match")?.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(tag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(row.body, { headers });
}

/** Batch several page keys in one round trip (bounded). */
export async function batchPages(request: Request, env: Env) {
  const url = new URL(request.url);
  const event = identifier(url.searchParams.get("event") || env.STAGING_EVENT);
  stagingEvent(event, env);
  const pages = (url.searchParams.get("pages") || "home,rankings").split(",").map((p) => p.trim()).filter(Boolean);
  if (!pages.length || pages.length > 6 || pages.some((p) => !PAGES.has(p))) throw new Fault(422, "Up to 6 known page keys required");

  const out: Record<string, unknown> = {};
  for (const page of pages) {
    const row = await env.DB.prepare(
      "SELECT body,revision,digest FROM page_snapshots WHERE event_id=? AND page=?"
    ).bind(event, page).first<any>();
    out[page] = row ? { ...JSON.parse(row.body), _revision: row.revision, _digest: row.digest } : { pending: true };
  }
  const rev = await env.DB.prepare("SELECT revision FROM event_revisions WHERE event_id=?").bind(event).first<number>("revision");
  return json({ event, revision: rev || 0, pages: out });
}
