"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { num, pct, rankClass } from "@/lib/format";
import type { TeamSummary } from "@/lib/types";
import { Loading, Empty, TeamIdentity } from "@/components/ui";

export default function DataPicklistPage() {
  const [data, setData] = useState<{ teams: TeamSummary[]; explanation: string; event_avg_epa: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<any>("/api/admin/data-picklist").then(setData).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;
  if (!data || data.teams.length === 0) return (<div><h1>Data Picklist</h1><Empty icon="trend" title="Not enough data yet" sub="Scout matches and set an event so EPA + schedule are available." /></div>);

  return (
    <div>
      <div className="page-title"><h1>Data Picklist</h1>
        <span className="badge muted">auto-ranked</span>
      </div>
      <p className="page-sub">Robots ranked by <b>true strength</b> — adjusted for consistency and strength of schedule, so teams carried by easy match-ups don't rank too high.</p>

      <div className="card" style={{ marginBottom: 16, borderColor: "var(--border-strong)" }}>
        <div className="row" style={{ gap: 10 }}><p style={{ margin: 0 }}>{data.explanation}</p></div>
        <div className="row" style={{ gap: 16, marginTop: 10, fontSize: "0.8rem" }} >
          <span className="badge muted">Event avg EPA: {data.event_avg_epa}</span>
          <span className="muted">SOS = opponent strength − partner help. Positive means a hard road travelled alone.</span>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>#</th><th>Team</th>
                <th className="num">True Score</th>
                <th className="num">Base</th>
                <th className="num">Reliab.</th>
                <th className="num">Opp EPA</th>
                <th className="num">Partner EPA</th>
                <th className="num">SOS</th>
                <th className="num">Sched. Adj</th>
              </tr>
            </thead>
            <tbody>
              {data.teams.map((r) => (
                <tr key={r.team}>
                  <td><span className={rankClass(r.rank || 0)}>{r.rank}</span></td>
                  <td><TeamIdentity team={r} /></td>
                  <td className="num mono"><b style={{ color: "var(--haze-glow)" }}>{num(r.true_score)}</b></td>
                  <td className="num mono">{num(r.base)}</td>
                  <td className="num mono">{pct(r.reliability)}</td>
                  <td className="num mono">{num(r.opp_strength, 0)}</td>
                  <td className="num mono">{num(r.partner_help, 0)}</td>
                  <td className="num mono" style={{ color: (r.sos || 0) >= 0 ? "#86efac" : "#fca5a5" }}>{(r.sos || 0) >= 0 ? "+" : ""}{num(r.sos, 0)}</td>
                  <td className="num mono" style={{ color: (r.sos_adjust || 0) >= 0 ? "#86efac" : "#fca5a5" }}>{(r.sos_adjust || 0) >= 0 ? "+" : ""}{num(r.sos_adjust)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ fontSize: "0.75rem", marginTop: 10 }}>
          Green schedule adjust = the team earned its ranking against tough opponents. Red = the ranking is inflated by easy match-ups / strong partners.
        </p>
      </div>
    </div>
  );
}
