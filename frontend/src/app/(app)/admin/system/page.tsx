"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLiveRefetch } from "@/lib/bus";
import { Loading, Stat } from "@/components/ui";

interface Health {
  generated_at: string;
  environment: string;
  event: { current_event: string; current_match: number };
  database: { engine: string; reachable: boolean; configured: boolean; project_id?: string; emulator?: boolean; error?: string; warning?: string };
  quota: {
    quota_day: string;
    resets_at: string;
    process_uptime_hours: number;
    operations: Record<
      string,
      { used: number; budget: number; free_tier_limit: number; pct_of_budget: number; projected_12h: number; shed: number }
    >;
  };
  cache: { backend: string; cached_total: number; documents: Record<string, number>; pending_writes: number; listen_mode: boolean };
  realtime: { websocket_clients: number; buffered_events: number };
  records: { scouting_total: number };
  reconciliation: {
    checked_matches: number;
    missing: {
      count: number;
      matches: number[];
      /** Every unscouted chair: which match, which alliance, which station. */
      slots: { match: number; alliance: "red" | "blue"; station: number; team: number }[];
    };
    /** Robots scouted by more than one person. Kept on purpose: this is
     *  coverage, not a fault: so it is reported apart from the findings. */
    double_scouted?: { count: number; items: { match: number; team: number; count: number }[] };
    duplicates: { count: number; items: { match: number; team: number; count: number }[] };
    wrong_team: { count: number; items: { match: number; team: number; scout_id: string; alliance?: string; station?: number }[] };
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
  if (!h) return <Loading label="Reading cloud diagnostics..." />;

  const dbOk = h.database.reachable;
  const rec = h.reconciliation;
  // Double-scouted robots are excluded on purpose: every report is kept, and
  // counting them as problems used to invite people to go and delete one.
  const issues = rec.missing.count + rec.wrong_team.count;
  const doubled = rec.double_scouted ?? rec.duplicates;
  const quota = h.quota?.operations ?? {};
  // Worst-case share of the day's free-tier allowance, projected over 12 hours.
  const quotaPct = Math.max(
    0,
    ...Object.values(quota).map((o) => (o.projected_12h / Math.max(1, o.free_tier_limit)) * 100)
  );

  return (
    <div>
      <div className="page-title"><h1>System Health</h1></div>


      {h.database.warning && (
        <div className="card" style={{ borderColor: "var(--amber)", marginBottom: 16 }}>
          <h3>Database warning</h3>
          <p style={{ margin: 0 }}>{h.database.warning}</p>
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Cloud records" value={h.records.scouting_total} />
        <Stat label="Missing reports" value={rec.missing.count} accent={rec.missing.count > 0} />
        <Stat label="Wrong team" value={rec.wrong_team.count} accent={rec.wrong_team.count > 0} />
        <Stat label="Double scouted" value={doubled.count} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Database</h3>
          <p style={{ margin: 0 }}>
            <Light ok={dbOk} />
            <b>{dbOk ? "Connected" : "Unreachable"}</b> · {h.database.engine}
            {h.database.project_id ? ` · ${h.database.project_id}` : ""} · {h.environment}
          </p>
          <p className="faint" style={{ marginTop: 6 }}>
            {h.cache.cached_total.toLocaleString()} documents cached in memory
            {h.cache.pending_writes > 0 ? ` · ${h.cache.pending_writes} writes queued` : ""}
            {" · "}{h.realtime.websocket_clients} live connection(s)
          </p>
          {!h.database.configured && (
            <p className="faint" style={{ marginTop: 6 }}>
              Local development store
            </p>
          )}
          {h.database.error && <p className="faint" style={{ marginTop: 6 }}>{h.database.error}</p>}
        </div>

        <div className="card">
          <h3>Firestore Quota (today)</h3>
          <p style={{ margin: "0 0 8px" }}>
            <Light ok={quotaPct < 60} warn={quotaPct < 100} />
            <b>
              {quotaPct < 60
                ? "Within allowance"
                : quotaPct < 100
                  ? "Near allowance"
                  : "Over allowance"}
            </b>
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Operation</th><th>Used</th><th>Projected 12h</th><th>Free/day</th></tr>
              </thead>
              <tbody>
                {["read", "write", "delete"].map((k) => (
                  <tr key={k}>
                    <td>{k}s</td>
                    <td className="num">{(quota[k]?.used ?? 0).toLocaleString()}</td>
                    <td className="num">{(quota[k]?.projected_12h ?? 0).toLocaleString()}</td>
                    <td className="num">{(quota[k]?.free_tier_limit ?? 0).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ marginTop: 6 }}>
            Counted by this instance since it started ({h.quota?.process_uptime_hours}h ago).
            Google&apos;s allowance resets at {h.quota?.resets_at}.
          </p>
        </div>

        <div className="card">
          <h3>Reconciliation</h3>
          {rec.checked_matches === 0 ? (
            <p className="faint" style={{ margin: 0 }}>
              No played matches
            </p>
          ) : (
            <>
              <p style={{ margin: "0 0 8px" }}>
                <Light ok={issues === 0} warn={issues > 0} />
                <b>{issues === 0 ? `All ${rec.checked_matches} played matches look clean` : `${issues} finding(s) across ${rec.checked_matches} played matches`}</b>
              </p>
              {rec.missing.count > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div className="faint" style={{ marginBottom: 6 }}>
                    Nobody scouted these robots. The station is the chair that was
                    empty, so this is who to go and ask:
                  </div>
                  <div className="missing-slots">
                    {(rec.missing.slots ?? []).map((slot) => (
                      <span
                        key={`${slot.match}-${slot.alliance}-${slot.station}`}
                        className={`missing-slot ${slot.alliance}`}
                      >
                        <b>Q{slot.match}</b>
                        <span className={`badge ${slot.alliance}`}>
                          {slot.alliance.toUpperCase()} {slot.station}
                        </span>
                        <span className="mono">{slot.team}</span>
                      </span>
                    ))}
                  </div>
                  {rec.missing.count > (rec.missing.slots?.length ?? 0) && (
                    <p className="faint" style={{ margin: "6px 0 0", fontSize: "0.78rem" }}>
                      and {rec.missing.count - (rec.missing.slots?.length ?? 0)} more.
                    </p>
                  )}
                </div>
              )}
              {doubled.count > 0 && (
                <p className="faint" style={{ margin: "8px 0 2px" }}>
                  <b>{doubled.count}</b> robot{doubled.count === 1 ? " was" : "s were"} scouted by
                  multiple scouts:{" "}
                  {doubled.items.map((d) => `Q${d.match} team ${d.team} (${d.count}×)`).join(", ")}
                  {doubled.count > doubled.items.length ? ", and more" : ""}.
                </p>
              )}
              {rec.wrong_team.items.map((w, i) => (
                <p key={i} className="faint" style={{ margin: "2px 0" }}>
                  Wrong team: Q{w.match}
                  {w.alliance ? ` ${w.alliance} ${w.station}` : ""}. {w.team} isn&apos;t on the field ({w.scout_id})
                </p>
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
              <Stat label="Carrier" value={h.network.carrier ?? "-"} />
              <Stat label="Signal" value={h.network.signal_quality ?? "-"} />
              <Stat label="Packet loss" value={h.network.packet_loss ?? "-"} />
            </div>
          ) : (
            <p className="faint" style={{ margin: 0 }}>
              <Light ok={false} warn /> Gateway unavailable. {h.network.reason}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
