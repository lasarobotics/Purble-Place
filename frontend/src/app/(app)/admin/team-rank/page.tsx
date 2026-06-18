"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
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

  useEffect(() => {
    setLoading(true);
    api<{ teams: TeamSummary[] }>(`/api/admin/rank?metric=${metric}`).then((r) => setRows(r.teams)).catch(() => setRows([])).finally(() => setLoading(false));
  }, [metric]);

  const fmt = FMT[metric] || ((v: number) => num(v, metric === "epa" ? 0 : 1));
  const maxVal = Math.max(...rows.map((r) => (r as any)[metric] || 0), 1);

  return (
    <div>
      <div className="page-title"><h1>📊 Team Rank</h1></div>
      <p className="page-sub">Rank every scouted team by the metric that matters for your pick.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <label className="field" style={{ margin: 0, maxWidth: 320 }}>
          <span>Rank by</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>
            {metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
      </div>

      {loading ? <Loading /> : rows.length === 0 ? <Empty icon="📊" title="No data yet" sub="Scout some matches first." /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>#</th><th>Team</th><th className="num">{metrics.find((m) => m.key === metric)?.label}</th><th style={{ width: "30%" }}></th><th className="num">Matches</th><th className="num">Avg</th><th className="num">Consist.</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.team}>
                    <td><span className={rankClass(r.rank || 0)}>{r.rank}</span></td>
                    <td><ClickableTeam team={r} /></td>
                    <td className="num mono"><b>{fmt((r as any)[metric] || 0)}</b></td>
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
