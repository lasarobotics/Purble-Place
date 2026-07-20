"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLiveRefetch } from "@/lib/bus";
import { Loading, Stat } from "@/components/ui";

interface Health {
  generated_at: string;
  megascout: boolean;
  event: { current_event: string; current_match: number };
  database: { engine: string; reachable: boolean; error?: string };
  records: { scouting_total: number };
  sync: {
    total: number;
    sent: number;
    failed: number;
    unsynced: number;
    cloud_sync_enabled: boolean;
    oldest_unsynced: null | {
      submission_id: string;
      match_number: number;
      team_number: number;
      scout_id: string;
      status: string;
      attempts: number;
      queued_at: string;
      age_seconds: number;
      last_error: string;
    };
  };
  worker: {
    running: boolean;
    detail?: string;
    last_beat?: string;
    seconds_since_beat?: number;
    last_synced?: number;
    cloud_reachable?: boolean;
    last_error?: string;
    cloud_sync_enabled: boolean;
  };
  missing_submissions: { count: number; matches: number[] };
  network: {
    available: boolean;
    reason?: string;
    carrier: string | null;
    signal_quality: number | null;
    packet_loss: number | null;
  };
}

function Light({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const cls = ok ? "green" : warn ? "amber" : "red";
  return <span className={"dot " + cls} style={{ marginRight: 8 }} />;
}

function fmtAge(s?: number) {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default function SystemHealthPage() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      setH(await api<Health>("/api/admin/system-health"));
      setErr("");
    } catch (e: any) {
      setErr(e?.message || "Failed to load system health");
    }
  }, []);

  // Refetch on live events + a slow interval so the panel stays current at the
  // pit table without hammering the server.
  useLiveRefetch(load, ["scout_submitted", "submission_ack", "match_advanced", "settings_changed", "bets_resolved"]);
  useEffect(() => {
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  if (err) return <div className="card" style={{ borderColor: "var(--red)" }}><h3>System Health</h3><p>{err}</p></div>;
  if (!h) return <Loading label="Reading MegaScout diagnostics…" />;

  const dbOk = h.database.reachable;
  const workerOk = h.worker.running;
  const synced = h.sync.unsynced === 0;

  return (
    <div>
      <div className="page-title"><h1>System Health</h1></div>
      <p className="page-sub">
        MegaScout server diagnostics — database, the Azure sync outbox, the sync
        worker, and event coverage. Auto-refreshes live.
      </p>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Scouting records" value={h.records.scouting_total} />
        <Stat label="Unsynced to cloud" value={h.sync.unsynced} accent={h.sync.unsynced > 0} />
        <Stat label="Shipped to Azure" value={h.sync.sent} />
        <Stat label="Missing matches" value={h.missing_submissions.count} accent={h.missing_submissions.count > 0} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Database</h3>
          <p style={{ margin: 0 }}>
            <Light ok={dbOk} />
            <b>{dbOk ? "Connected" : "Unreachable"}</b> · {h.database.engine}
            {h.megascout ? " · MegaScout" : " · dev"}
          </p>
          {h.database.error && <p className="faint" style={{ marginTop: 6 }}>{h.database.error}</p>}
        </div>

        <div className="card">
          <h3>Azure Sync Worker</h3>
          <p style={{ margin: 0 }}>
            <Light ok={workerOk} warn={!workerOk && !!h.worker.last_beat} />
            <b>{workerOk ? "Running" : "Not responding"}</b>
            {h.worker.last_beat && <> · last beat {fmtAge(h.worker.seconds_since_beat)}</>}
          </p>
          <div className="faint" style={{ marginTop: 6, fontSize: "0.82rem" }}>
            {h.worker.cloud_sync_enabled
              ? <>Cloud endpoint {h.worker.cloud_reachable ? "reachable" : "unreachable"} · last cycle synced {h.worker.last_synced ?? 0}</>
              : <>Local-only mode — no CLOUD_SYNC_URL set (records stay durably queued)</>}
          </div>
          {h.worker.last_error && <p className="faint" style={{ marginTop: 6 }}>{h.worker.last_error}</p>}
          {h.worker.detail && <p className="faint" style={{ marginTop: 6 }}>{h.worker.detail}</p>}
        </div>

        <div className="card">
          <h3>Outbox → Azure</h3>
          <p style={{ margin: "0 0 10px" }}>
            <Light ok={synced} warn={!synced} />
            <b>{synced ? "All caught up" : `${h.sync.unsynced} awaiting sync`}</b>
            {h.sync.failed > 0 && <> · {h.sync.failed} retrying</>}
          </p>
          {h.sync.oldest_unsynced ? (
            <div className="report-grid" style={{ marginTop: 0 }}>
              <div>
                <div className="faint">Oldest queued</div>
                <p>Q{h.sync.oldest_unsynced.match_number} · team {h.sync.oldest_unsynced.team_number}</p>
              </div>
              <div>
                <div className="faint">Waiting</div>
                <p>{fmtAge(h.sync.oldest_unsynced.age_seconds)} · {h.sync.oldest_unsynced.attempts} attempts</p>
              </div>
              {h.sync.oldest_unsynced.last_error && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <div className="faint">Last error</div>
                  <p>{h.sync.oldest_unsynced.last_error}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="faint" style={{ margin: 0 }}>Every submission is on Azure.</p>
          )}
        </div>

        <div className="card">
          <h3>Match Coverage</h3>
          {h.missing_submissions.count === 0 ? (
            <p style={{ margin: 0 }}><Light ok /> <b>Every played match has scouting.</b></p>
          ) : (
            <>
              <p style={{ margin: "0 0 8px" }}>
                <Light ok={false} warn /> <b>{h.missing_submissions.count} played match(es) with no scouting</b>
              </p>
              <div className="tag-list">
                {h.missing_submissions.matches.map((m) => (
                  <span key={m} className="chip static sm">Q{m}</span>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <h3>Network / Gateway</h3>
          {h.network.available ? (
            <div className="grid cols-3">
              <Stat label="Carrier" value={h.network.carrier ?? "—"} />
              <Stat label="Signal" value={h.network.signal_quality ?? "—"} />
              <Stat label="Packet loss" value={h.network.packet_loss ?? "—"} />
            </div>
          ) : (
            <p className="faint" style={{ margin: 0 }}>
              <Light ok={false} warn /> Gateway stats unavailable — {h.network.reason}. Set
              {" "}<code>HAZEHUB_GATEWAY_STATS_URL</code> to the UniFi/gateway stats API to
              show carrier, signal quality and packet loss here.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
