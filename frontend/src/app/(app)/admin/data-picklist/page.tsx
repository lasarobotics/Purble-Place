"use client";
import { MetricLabel } from "@/components/MetricLabel";
import { METRICS } from "@/lib/metrics";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useLiveRefetch } from "@/lib/bus";
import { num, pct, rankClass } from "@/lib/format";
import type { TeamSummary } from "@/lib/types";
import { Loading, Empty, TeamIdentity } from "@/components/ui";

export default function DataPicklistPage() {
  const [data, setData] = useState<{ teams: TeamSummary[]; explanation: string; event_avg_epa: number } | null>(null);
  const [loading, setLoading] = useState(true);

  // Re-rank live whenever scouting lands or the event changes.
  const load = useCallback(() => {
    api<any>("/api/admin/data-picklist").then(setData).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useLiveRefetch(load);

  if (loading) return <Loading />;
  if (!data || data.teams.length === 0) return (<div><h1>Data Picklist</h1><Empty icon="trend" title="Not enough data yet" /></div>);

  return (
    <div>
      <div className="page-title"><h1>Data Picklist</h1></div>


      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>#</th><th>Team</th>
                <th className="num"><MetricLabel>True Score</MetricLabel></th>
                <th className="num"><MetricLabel>Base</MetricLabel></th>
                <th className="num"><MetricLabel>Reliab.</MetricLabel></th>
                <th className="num"><MetricLabel>Opp EPA</MetricLabel></th>
                <th className="num"><MetricLabel>Partner EPA</MetricLabel></th>
                <th className="num"><MetricLabel>SOS</MetricLabel></th>
                <th className="num"><MetricLabel>Sched. Adj</MetricLabel></th>
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
                  <td className="num mono">{(r.sos || 0) >= 0 ? "+" : ""}{num(r.sos, 0)}</td>
                  <td className="num mono">{(r.sos_adjust || 0) >= 0 ? "+" : ""}{num(r.sos_adjust)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
