import { canonical,digest,Env,Fault,identifier,json,now,Principal,readBody,stagingEvent,admin } from "../shared/core";

export async function submit(request: Request, env: Env, user: Principal) {
  if (user.role !== "scouter" && user.role !== "admin") throw new Fault(403,"Scouting account required");
  const body = await readBody(request);
  const id = identifier(body.submission_id), event = identifier(body.event_key);
  stagingEvent(event,env);
  if (!Number.isSafeInteger(body.team_number) || body.team_number < 1 || !Number.isSafeInteger(body.match_number) || body.match_number < 1) throw new Fault(422,"Positive team and match numbers required");
  if (!Array.isArray(body.heatmap) || body.heatmap.length > 2000 || !["qm","ef","qf","sf","f"].includes(body.comp_level || "qm")) throw new Fault(422,"Invalid report shape");
  for (const dot of body.heatmap) {
    if (!dot || !["auto","teleop"].includes(dot.phase) || !["made","missed"].includes(dot.result) || !Number.isFinite(dot.x) || !Number.isFinite(dot.y)) throw new Fault(422,"Invalid heatmap dot");
  }
  // Ignore client-supplied identity/hash. Preserve all form answers verbatim.
  const { payload_hash: ignored, scout_id: ignoredId, ...answers } = body;
  const payload = canonical({...answers,scout_id:user.id});
  const hash = await digest(payload);
  const written = await env.DB.prepare("INSERT INTO reports(id,event_id,team,match_number,owner_id,payload,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
    .bind(id,event,body.team_number,body.match_number,user.id,payload,hash,now()).run();
  const existing = await env.DB.prepare("SELECT owner_id,payload_hash FROM reports WHERE id=?").bind(id).first<any>();
  if (!existing || existing.owner_id !== user.id || existing.payload_hash !== hash) throw new Fault(409,"UUID already belongs to a different report");
  return json({submission_id:id,status:written.meta.changes ? "created" : "already_exists"},written.meta.changes ? 201 : 200);
}

export async function auditReport(request: Request, env: Env, user: Principal, reportId: string) {
  admin(user);
  const body = await readBody(request);
  if (!["void","restore"].includes(body.operation) || !Number.isSafeInteger(body.expected_version) || body.expected_version < 1) throw new Fault(422,"Operation and expected_version required");
  const op = identifier(body.operation_id);
  const row = await env.DB.prepare("SELECT event_id FROM reports WHERE id=?").bind(reportId).first<any>();
  if (!row) throw new Fault(404,"Report not found"); stagingEvent(row.event_id,env);
  const hash = await digest(canonical(body));
  const prior = await env.DB.prepare("SELECT * FROM audit WHERE id=?").bind(op).first<any>();
  if (prior) {
    if (prior.report_id !== reportId || prior.actor !== user.id || prior.payload !== hash) throw new Fault(409,"Operation ID conflict");
    return json({ok:true,version:prior.previous_version+1});
  }
  const results = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO audit SELECT ?,id,?,version,?,?,? FROM reports WHERE id=? AND version=?")
      .bind(op,user.id,body.operation,hash,now(),reportId,body.expected_version),
    env.DB.prepare("UPDATE reports SET voided=?,version=version+1 WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM audit WHERE id=? AND payload=? AND actor=?)")
      .bind(body.operation === "void" ? 1 : 0,reportId,body.expected_version,op,hash,user.id)
  ]);
  if (!results[1].meta.changes) throw new Fault(409,"Report changed; reload before editing");
  return json({ok:true,version:body.expected_version+1});
}
