import { admin,canonical,digest,Env,Fault,identifier,json,now,Principal,readBody } from "../shared/core";

export async function meeting(request: Request, env: Env, user: Principal, id: string) {
  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM meetings WHERE id=?").bind(id).first<any>();
    if (!row) throw new Fault(404,"Meeting not found");
    return json({id,revision:row.revision,...JSON.parse(row.body)});
  }
  if (request.method !== "PUT") throw new Fault(405,"Method not allowed");
  admin(user);
  const body = await readBody(request,32768), op = identifier(body.operation_id);
  if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) throw new Fault(422,"expected_revision required");
  for (const list of [body.first,body.second]) {
    if (!Array.isArray(list) || list.length>150 || new Set(list).size!==list.length || list.some(t=>!Number.isSafeInteger(t)||t<1)) throw new Fault(422,"Unique positive teams required");
  }
  const data = canonical({first:body.first,second:body.second}), hash = await digest(canonical(body));
  const old = await env.DB.prepare("SELECT * FROM meeting_operations WHERE id=?").bind(op).first<any>();
  if (old) {
    if (old.meeting_id!==id || old.actor!==user.id || old.payload_hash!==hash) throw new Fault(409,"Operation ID conflict");
    return json({id,revision:old.revision});
  }
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO meetings(id,updated_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING").bind(id,now()),
    env.DB.prepare("INSERT OR IGNORE INTO meeting_operations SELECT ?,id,?,revision,?,revision+1,? FROM meetings WHERE id=? AND revision=?")
      .bind(op,user.id,hash,now(),id,body.expected_revision),
    env.DB.prepare("UPDATE meetings SET revision=revision+1,body=?,updated_at=? WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM meeting_operations WHERE id=? AND payload_hash=? AND actor=?)")
      .bind(data,now(),id,body.expected_revision,op,hash,user.id)
  ]);
  if (!results[2].meta.changes) throw new Fault(409,"Meeting changed; reload before editing");
  // Failure to notify does not undo a committed edit. Reconnect/GET reads D1.
  try { await env.MEETINGS.get(env.MEETINGS.idFromName(id)).fetch(new Request(`https://internal/notify/${id}`,{method:"POST"})); } catch {}
  return json({id,revision:body.expected_revision+1});
}

export async function ticket(request: Request, env: Env, user: Principal) {
  const body = await readBody(request,1024), id = identifier(body.meeting_id);
  if (!await env.DB.prepare("SELECT id FROM meetings WHERE id=?").bind(id).first()) throw new Fault(404,"Meeting not found");
  const token = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO socket_tickets VALUES(?,?,?,?,?,?)")
    .bind(token,user.id,id,user.credential_revision,now()+30000,user.exp*1000).run();
  return json({ticket:token,expires_in:30});
}
