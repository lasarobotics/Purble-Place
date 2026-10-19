import { canonical, digest, Env, now } from "../shared/core";
import { rebuildAnalysis } from "./analytics";
import { refreshExternal } from "./external";

// D1 is the job source of truth. A missing/expired Queue message is recoverable.
export async function dispatch(env: Env) {
  await env.DB.prepare("DELETE FROM socket_tickets WHERE expires_at<?").bind(now()).run();
  await env.DB.prepare("DELETE FROM external_cache WHERE expires_at<?").bind(now()).run();
  const due = await env.DB.prepare(
    "SELECT id FROM jobs WHERE status IN ('pending','queued') AND next_attempt_at<=? AND lease_until<? AND expires_at>? ORDER BY priority DESC, next_attempt_at LIMIT 8"
  ).bind(now(), now(), now()).all<{ id: string }>();
  for (const job of due.results) {
    const claimed = await env.DB.prepare(
      "UPDATE jobs SET status='queued',lease_until=? WHERE id=? AND status IN ('pending','queued') AND lease_until<?"
    ).bind(now() + 120000, job.id, now()).run();
    if (!claimed.meta.changes) continue;
    try {
      await env.JOBS.send({ id: job.id });
    } catch {
      await env.DB.prepare(
        "UPDATE jobs SET status='pending',next_attempt_at=?,lease_until=0 WHERE id=? AND status='queued'"
      ).bind(now() + 60000, job.id).run();
    }
  }
}

async function writeSnapshot(env: Env, eventId: string, kind: string, revision: number | null, payload: unknown) {
  const body = canonical(payload);
  const hash = await digest(body);
  await env.DB.prepare(
    `INSERT INTO snapshots(event_id,kind,revision,body,digest,created_at)
     SELECT ?,?,?,?,?,? WHERE (SELECT revision FROM event_revisions WHERE event_id=?)=?
     ON CONFLICT(event_id,kind) DO UPDATE SET revision=excluded.revision,body=excluded.body,digest=excluded.digest,created_at=excluded.created_at
     WHERE excluded.revision>=snapshots.revision`
  ).bind(eventId, kind, revision, body, hash, now(), eventId, revision).run();
}

async function writePage(env: Env, eventId: string, page: string, revision: number | null, payload: unknown) {
  const body = canonical(payload);
  const hash = await digest(body);
  await env.DB.prepare(
    `INSERT INTO page_snapshots(event_id,page,revision,body,digest,created_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(event_id,page) DO UPDATE SET revision=excluded.revision,body=excluded.body,digest=excluded.digest,created_at=excluded.created_at
     WHERE excluded.revision>=page_snapshots.revision`
  ).bind(eventId, page, revision, body, hash, now()).run();
}

export async function consume(env: Env, id: string) {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<any>();
  if (!job || job.status === "done" || job.status === "dead") return;
  if (job.expires_at <= now()) {
    await env.DB.prepare("UPDATE jobs SET status='dead',error='Expired; operator review required' WHERE id=?").bind(id).run();
    return;
  }
  if (job.next_attempt_at > now()) return;
  const revision = await env.DB.prepare("SELECT revision FROM event_revisions WHERE event_id=?")
    .bind(job.event_id)
    .first<number>("revision");

  try {
    if (job.type === "overview") {
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS reports, COUNT(DISTINCT team) AS teams FROM reports WHERE event_id=? AND voided=0"
      ).bind(job.event_id).first<any>();
      await writeSnapshot(env, job.event_id, "overview", revision, { event: job.event_id, revision, ...count });
      await env.DB.prepare(
        "UPDATE jobs SET status='done',lease_until=0,result_ref=? WHERE id=? AND (SELECT revision FROM event_revisions WHERE event_id=?)=?"
      ).bind(`overview:${job.event_id}:${revision}`, id, job.event_id, revision).run();
      return;
    }

    if (job.type === "analysis") {
      const result = await rebuildAnalysis(env, job.event_id, revision);
      if (!result.complete) {
        // Bounded batch incomplete — requeue without burning a failure attempt.
        await env.DB.prepare(
          "UPDATE jobs SET status='pending',lease_until=0,next_attempt_at=?,error=? WHERE id=?"
        ).bind(now() + 1000, `partial:${result.remaining} teams remaining`, id).run();
        try { await env.JOBS.send({ id }); } catch { /* cron dispatch recovers */ }
        return;
      }
      await writeSnapshot(env, job.event_id, "analysis", revision, result.analysis);
      await writePage(env, job.event_id, "home", revision, result.home);
      await writePage(env, job.event_id, "rankings", revision, result.rankings);
      await writePage(env, job.event_id, "data-analysis", revision, result.analysis);
      await env.DB.prepare(
        "UPDATE jobs SET status='done',lease_until=0,result_ref=? WHERE id=? AND (SELECT revision FROM event_revisions WHERE event_id=?)=?"
      ).bind(`analysis:${job.event_id}:${revision}`, id, job.event_id, revision).run();
      return;
    }

    if (job.type === "external") {
      await refreshExternal(env, job.event_id, JSON.parse(job.payload || "{}"));
      await env.DB.prepare("UPDATE jobs SET status='done',lease_until=0,result_ref=? WHERE id=?")
        .bind(`external:${job.event_id}:${now()}`, id).run();
      return;
    }

    throw new Error(`Unsupported job type: ${job.type}`);
  } catch {
    const attempts = job.attempts + 1;
    const delay = Math.min(3600000, 30000 * 2 ** attempts);
    await env.DB.prepare(
      "UPDATE jobs SET attempts=?,status=?,next_attempt_at=?,lease_until=0,error='Background processing failed' WHERE id=?"
    ).bind(attempts, attempts >= job.max_attempts ? "dead" : "pending", now() + delay, id).run();
  }
}
