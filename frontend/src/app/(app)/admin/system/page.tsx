"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLiveRefetch } from "@/lib/bus";
import { Loading, Stat } from "@/components/ui";

interface Health {
  generated_at: string;
  environment: string;
  event: { current_event: string; current_match: number };
  database: { engine: string; reachable: boolean; configured: boolean; error?: string; warning?: string };
  records: { scouting_total: number };
  reconciliation: {
    checked_matches: number;
    missing: { count: number; matches: number[] };
    duplicates: { count: number; items: { match: number; team: number; count: number }[] };
    wrong_team: { count: number; items: { match: number; team: number; scout_id: string }[] };
    by_match: { match: number; submissions: number; teams_covered: number }[];
  };
  scouts: {
    scout_id: string;
    display_name: string;
    matches_scouted: number;
    last_seen: string | null;
    seconds_since_seen: number | null;
    potentially_stale: boolean;
  }[];
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

function fmtAge(s?: number | null) {
  if (s == null) return "never";
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

  useLiveRefetch(load, ["scout_submitted", "submission_ack", "match_advanced", "settings_changed"]);
  useEffect(() => {
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, [load]);

  if (err) return <div className="card" style={{ borderColor: "var(--red)" }}><h3>System Health</h3><p>{err}</p></div>;
  if (!h) return <Loading label="Reading cloud diagnostics…" />;

  const dbOk = h.database.reachable;
  const rec = h.reconciliation;
  const issues = rec.missing.count + rec.duplicates.count + rec.wrong_team.count;
  const stale = h.scouts.filter((s) => s.potentially_stale);

  return (
    <div>
      <div className="page-title"><h1>System Health</h1></div>
      <p className="page-sub">
        Cloud database, reconciliation against the match schedule, and scout
        check-ins. Devices that go quiet may still hold unsynced records —
        chase them before shutting anything down.
      </p>

      {h.database.warning && (
        <div className="card" style={{ borderColor: "var(--amber)", marginBottom: 16 }}>
          <h3>Configuration Warning</h3>
          <p style={{ margin: 0 }}>{h.database.warning}</p>
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Cloud records" value={h.records.scouting_total} />
        <Stat label="Missing matches" value={rec.missing.count} accent={rec.missing.count > 0} />
        <Stat label="Data issues" value={rec.duplicates.count + rec.wrong_team.count} accent={rec.duplicates.count + rec.wrong_team.count > 0} />
        <Stat label="Quiet scouts" value={stale.length} accent={stale.length > 0} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Database</h3>
          <p style={{ margin: 0 }}>
            <Light ok={dbOk} />
            <b>{dbOk ? "Connected" : "Unreachable"}</b> · {h.database.engine} · {h.environment}
          </p>
          {!h.database.configured && (
            <p className="faint" style={{ marginTop: 6 }}>Running on the local SQLite fallback.</p>
          )}
          {h.database.error && <p className="faint" style={{ marginTop: 6 }}>{h.database.error}</p>}
        </div>

        <div className="card">
          <h3>Reconciliation</h3>
          {rec.checked_matches === 0 ? (
            <p className="faint" style={{ margin: 0 }}>
              Set the event and advance the current match to start comparing the
              schedule against received submissions.
            </p>
          ) : (
            <>
              <p style={{ margin: "0 0 8px" }}>
                <Light ok={issues === 0} warn={issues > 0} />
                <b>{issues === 0 ? `All ${rec.checked_matches} played matches look clean` : `${issues} finding(s) across ${rec.checked_matches} played matches`}</b>
              </p>
              {rec.missing.count > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div className="faint" style={{ marginBottom: 4 }}>No scouting at all:</div>
                  <div className="tag-list">
                    {rec.missing.matches.map((m) => <span key={m} className="chip static sm">Q{m}</span>)}
                  </div>
                </div>
              )}
              {rec.duplicates.items.map((d, i) => (
                <p key={i} className="faint" style={{ margin: "2px 0" }}>Duplicate: Q{d.match} team {d.team} scouted {d.count}×</p>
              ))}
              {rec.wrong_team.items.map((w, i) => (
                <p key={i} className="faint" style={{ margin: "2px 0" }}>Wrong team: Q{w.match} — {w.team} isn't on the field ({w.scout_id})</p>
              ))}
            </>
          )}
        </div>

        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <h3>Scout Check-ins</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Scout</th><th>Matches</th><th>Last seen</th><th>Status</th></tr>
              </thead>
              <tbody>
                {h.scouts.map((s) => (
                  <tr key={s.scout_id}>
                    <td>{s.display_name}</td>
                    <td className="num">{s.matches_scouted}</td>
                    <td>{fmtAge(s.seconds_since_seen)}</td>
                    <td>
                      {s.potentially_stale
                        ? <span className="badge amber">may hold unsynced records</span>
                        : <span className="badge green">active</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
