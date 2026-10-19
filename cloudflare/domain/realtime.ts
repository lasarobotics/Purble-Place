import { DurableObject } from "cloudflare:workers";
import { Env,json,now } from "../shared/core";

export class MeetingRoom extends DurableObject<Env> {
  async fetch(request: Request) {
    const url = new URL(request.url), id = url.pathname.split("/").pop()!;
    if (url.pathname.startsWith("/notify/") && request.method === "POST") {
      const row = await this.env.DB.prepare("SELECT revision FROM meetings WHERE id=?").bind(id).first<any>();
      const sockets = this.ctx.getWebSockets();
      if (!sockets.length) return json({ok:true});
      // One bounded account read for all sockets, rather than a query per client.
      const ids = [...new Set(sockets.map(s => s.deserializeAttachment()?.account_id as string).filter(Boolean))];
      const valid = new Map<string, string>();
      if (ids.length) {
        const rows = await this.env.DB.prepare(
          `SELECT id,credential_revision FROM accounts WHERE active=1 AND id IN (${ids.map(() => "?").join(",")})`
        ).bind(...ids).all<any>();
        for (const r of rows.results) valid.set(r.id, r.credential_revision);
      }
      for (const ws of sockets) {
        const a = ws.deserializeAttachment();
        try {
          if (!a || a.session_expires_at <= now() || valid.get(a.account_id) !== a.credential_revision) {
            ws.close(1008, "Sign in again");
            continue;
          }
          // Revision-only notifications prevent slow clients accumulating giant payloads.
          ws.send(JSON.stringify({ event: "meeting_changed", meeting_id: id, revision: row?.revision || 0 }));
        } catch {
          try { ws.close(1011, "Reconnect"); } catch { /* already closed */ }
        }
      }
      return json({ok:true});
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({detail:"WebSocket upgrade required"},426);
    if (this.ctx.getWebSockets().length >= 100) return json({detail:"Meeting connection limit"},429);
    const token = url.searchParams.get("ticket") || "";
    const grant = await this.env.DB.prepare("DELETE FROM socket_tickets WHERE id=? AND meeting_id=? AND expires_at>? RETURNING *").bind(token,id,now()).first<any>();
    if (!grant || grant.session_expires_at<=now()) return json({detail:"Ticket expired"},401);
    const account = await this.env.DB.prepare("SELECT credential_revision FROM accounts WHERE id=? AND active=1").bind(grant.account_id).first<any>();
    if (!account || account.credential_revision !== grant.credential_revision) return json({detail:"Session revoked"},401);
    const pair = new WebSocketPair(); const [client,server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(grant);
    const row = await this.env.DB.prepare("SELECT revision FROM meetings WHERE id=?").bind(id).first<any>();
    server.send(JSON.stringify({event:"connected",meeting_id:id,revision:row?.revision || 0}));
    return new Response(null,{status:101,webSocket:client});
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const a = ws.deserializeAttachment();
    const account = await this.env.DB.prepare("SELECT credential_revision FROM accounts WHERE id=? AND active=1").bind(a.account_id).first<any>();
    if (!account || account.credential_revision!==a.credential_revision || a.session_expires_at<=now()) { ws.close(1008,"Sign in again"); return; }
    if (message !== "ping") { ws.close(1008,"Only ping is supported; edit through the API"); return; }
    ws.send("pong");
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) { ws.close(code,reason); }
  webSocketError(ws: WebSocket) { ws.close(1011,"Reconnect"); }
}
