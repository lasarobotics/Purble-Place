/**
 * Offline queue flush — preserves FastAPI `/api/sync/scout` result statuses.
 * Critical writes commit in D1 before ack; never fire-and-forget.
 */
import { canonical, digest, Env, Fault, identifier, json, now, Principal, readBody, stagingEvent } from "../shared/core";

export async function syncScout(request: Request, env: Env, user: Principal) {
  if (user.role !== "scouter" && user.role !== "admin") throw new Fault(403, "Scouting account required");
  const body = await readBody(request, 512_000);
  const records = Array.isArray(body.records) ? body.records : Array.isArray(body) ? body : null;
  if (!records || records.length < 1 || records.length > 50) throw new Fault(422, "1–50 records required");

  const results: Array<{ submission_id: string; status: string; detail?: string }> = [];
  for (const row of records) {
    try {
      const id = identifier(row.submission_id);
      const event = identifier(row.event_key);
      stagingEvent(event, env);
      if (!Number.isSafeInteger(row.team_number) || row.team_number < 1 || !Number.isSafeInteger(row.match_number) || row.match_number < 1) {
        results.push({ submission_id: id, status: "invalid", detail: "Positive team and match numbers required" });
        continue;
      }
      const { payload_hash: _ignored, scout_id: _sid, ...answers } = row;
      const payload = canonical({ ...answers, scout_id: user.id });
      const hash = await digest(payload);
      const written = await env.DB.prepare(
        "INSERT INTO reports(id,event_id,team,match_number,owner_id,payload,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
      ).bind(id, event, row.team_number, row.match_number, user.id, payload, hash, now()).run();
      const existing = await env.DB.prepare("SELECT owner_id,payload_hash FROM reports WHERE id=?").bind(id).first<any>();
      if (!existing || existing.owner_id !== user.id || existing.payload_hash !== hash) {
        results.push({ submission_id: id, status: "conflict" });
        continue;
      }
      results.push({ submission_id: id, status: written.meta.changes ? "created" : "already_exists" });
    } catch (err) {
      const id = typeof row?.submission_id === "string" ? row.submission_id : "unknown";
      if (err instanceof Fault && err.status === 422) results.push({ submission_id: id, status: "invalid", detail: err.message });
      else results.push({ submission_id: id, status: "retry", detail: "Transient write failure" });
    }
  }
  return json({ results });
}
