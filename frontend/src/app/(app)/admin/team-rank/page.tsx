"use client";
import { MetricLabel } from "@/components/MetricLabel";
import { METRICS } from "@/lib/metrics";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLiveRefetch } from "@/lib/bus";
import { num, pct, rankClass } from "@/lib/format";
import type { TeamSummary } from "@/lib/types";
import { Loading, Empty } from "@/components/ui";
import { Bar } from "@/components/ui";
import { ClickableTeam } from "@/components/TeamDetailModal";

const FMT: Record<string, (v: number) => string> = {
  consistency: (v) => pct(v),
  climb_rate: (v) => pct(v),
  defense_rate: (v) => pct(v),
};

export default function TeamRankPage() {
  const [metrics, setMetrics] = useState<{ key: string; label: string }[]>([]);
  const [metric, setMetric] = useState("avg_points");
  const [rows, setRows] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ metrics: { key: string; label: string }[] }>("/api/admin/metrics").then((r) => setMetrics(r.metrics)).catch(() => {});
  }, []);

  const load = useCallback(() => {
    api<{ teams: TeamSummary[] }>(`/api/admin/rank?metric=${metric}`).then((r) => setRows(r.teams)).catch(() => setRows([])).finally(() => setLoading(false));
  }, [metric]);
  useEffect(() => setLoading(true), [metric]);
  useLiveRefetch(load);

  const fmt = (METRICS[metric]?.percent ? pct : FMT[metric]) || ((v: number) => num(v, metric === "epa" ? 0 : 1));
  const maxVal = Math.max(...rows.map((r) => (r as any)[metric] || 0), 1);

  return (
    <div>
      <div className="page-title"><h1>Team Rank</h1></div>
      <p className="page-sub">Rank every scouted team by the metric that matters for your pick.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <label className="field" style={{ margin: 0, maxWidth: 320 }}>
          <span>Rank by · <MetricLabel metric={metric} /></span>
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>
            {metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
      </div>

      {loading ? <Loading /> : rows.length === 0 ? <Empty icon="chart" title="No data yet" sub="Scout some matches first." /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>#</th><th>Team</th><th className="num"><MetricLabel metric={metric} /></th><th style={{ width: "30%" }}></th><th className="num"><MetricLabel>Matches</MetricLabel></th><th className="num"><MetricLabel>Avg</MetricLabel></th><th className="num"><MetricLabel>Consist.</MetricLabel></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.team}>
                    <td><span className={rankClass(r.rank || 0)}>{r.rank}</span></td>
                    <td><ClickableTeam team={r} /></td>
                    <td className="num mono"><b>{(r as any)[metric] == null ? "\u2014" : fmt((r as any)[metric])}</b></td>
                    <td><Bar value={(r as any)[metric] || 0} max={maxVal} /></td>
                    <td className="num mono">{r.matches}</td>
                    <td className="num mono">{num(r.avg_points)}</td>
                    <td className="num mono">{pct(r.consistency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
