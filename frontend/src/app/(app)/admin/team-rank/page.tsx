"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MetricLabel } from "@/components/MetricLabel";
import { METRICS } from "@/lib/metrics";
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

type DataAnalysisRow = Pick<TeamSummary, "team" | "nickname" | "avatar" | "matches"> & {
  scoring_benchmark?: TeamSummary["scoring_benchmark"];
  defense_capability: number | null;
  l4m_defense_capability: number | null;
  consistency: number;
  l4m_consistency: number;
  skew_distribution: number;
  l4m_skew_distribution: number;
  failure_rate: number;
  l4m_failure_rate: number;
  foul_match_rate: number;
  climb_success_rate: number;
  l4m_climb_success_rate: number;
  ranking_point_prediction: number | null;
};

type SortDir = "asc" | "desc";
type AnalysisKey = keyof Omit<DataAnalysisRow, "team" | "nickname" | "avatar" | "scoring_benchmark">;

const ANALYSIS_COLUMNS: { key: AnalysisKey; label: string; fmt?: (v: number) => string }[] = [
  { key: "defense_capability", label: "Defense Capability", fmt: (v) => num(v, 2) },
  { key: "l4m_defense_capability", label: "L4M Defense Capability", fmt: (v) => num(v, 2) },
  { key: "consistency", label: "Consistency", fmt: pct },
  { key: "l4m_consistency", label: "L4M Consistency", fmt: pct },
  { key: "skew_distribution", label: "Skew Distribution", fmt: (v) => num(v, 3) },
  { key: "l4m_skew_distribution", label: "L4M Skew Distribution", fmt: (v) => num(v, 3) },
  { key: "failure_rate", label: "Failure Rate", fmt: pct },
  { key: "l4m_failure_rate", label: "L4M Failure Rate", fmt: pct },
  { key: "foul_match_rate", label: "Foul Match Rate", fmt: pct },
  { key: "climb_success_rate", label: "Climb Success Rate", fmt: pct },
  { key: "l4m_climb_success_rate", label: "L4M Climb Success Rate", fmt: pct },
  { key: "ranking_point_prediction", label: "Ranking Point Prediction", fmt: (v) => num(v, 1) },
];

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        color: "inherit",
        background: "none",
        border: 0,
        padding: 0,
        font: "inherit",
        fontWeight: active ? 700 : undefined,
        cursor: "pointer",
        textAlign: "right",
      }}
      aria-sort={active ? (dir === "desc" ? "descending" : "ascending") : "none"}
    >
      <MetricLabel>{label}</MetricLabel>{active ? (dir === "desc" ? " ↓" : " ↑") : ""}
    </button>
  );
}

function analysisValue(row: DataAnalysisRow, key: AnalysisKey): number | null {
  return row[key] as number | null;
}

function formatAnalysisValue(row: DataAnalysisRow, key: AnalysisKey): string {
  const value = analysisValue(row, key);
  if (value == null || !Number.isFinite(value)) return "-";
  return ANALYSIS_COLUMNS.find((c) => c.key === key)?.fmt?.(value) ?? num(value, 2);
}

export default function TeamRankPage() {
  const [tab, setTab] = useState<"rank" | "analysis">("rank");
  const [metrics, setMetrics] = useState<{ key: string; label: string }[]>([]);
  const [metric, setMetric] = useState("avg_points");
  const [rows, setRows] = useState<TeamSummary[]>([]);
  const [analysisRows, setAnalysisRows] = useState<DataAnalysisRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [analysisLoading, setAnalysisLoading] = useState(true);
  const [analysisError, setAnalysisError] = useState("");
  const [analysisSort, setAnalysisSort] = useState<{ key: AnalysisKey; dir: SortDir }>({
    key: "skew_distribution",
    dir: "desc",
  });

  useEffect(() => {
    api<{ metrics: { key: string; label: string }[] }>("/api/admin/metrics").then((r) => setMetrics(r.metrics)).catch(() => {});
  }, []);

  const load = useCallback(() => {
    api<{ teams: TeamSummary[] }>(`/api/admin/rank?metric=${metric}`).then((r) => setRows(r.teams)).catch(() => setRows([])).finally(() => setLoading(false));
  }, [metric]);
  useEffect(() => setLoading(true), [metric]);
  useLiveRefetch(load);

  const loadAnalysis = useCallback(() => {
    api<{ teams: DataAnalysisRow[] }>("/api/admin/data-analysis")
      .then((r) => { setAnalysisRows(r.teams); setAnalysisError(""); })
      .catch(() => setAnalysisError("Data Analysis could not refresh. Please retry."))
      .finally(() => setAnalysisLoading(false));
  }, []);
  useLiveRefetch(loadAnalysis);

  const sortedAnalysisRows = useMemo(() => {
    const { key, dir } = analysisSort;
    return [...analysisRows].sort((a, b) => {
      const av = analysisValue(a, key);
      const bv = analysisValue(b, key);
      if (av == null || !Number.isFinite(av)) return bv == null ? 0 : 1;
      if (bv == null || !Number.isFinite(bv)) return -1;
      const an = av == null || !Number.isFinite(av) ? Number.NEGATIVE_INFINITY : av;
      const bn = bv == null || !Number.isFinite(bv) ? Number.NEGATIVE_INFINITY : bv;
      return dir === "desc" ? bn - an : an - bn;
    });
  }, [analysisRows, analysisSort]);

  const setSort = (key: AnalysisKey) => {
    setAnalysisSort((prev) => ({ key, dir: prev.key === key && prev.dir === "desc" ? "asc" : "desc" }));
  };

  const fmt = (METRICS[metric]?.percent ? pct : FMT[metric]) || ((v: number) => num(v, metric === "epa" ? 0 : 1));
  const reference = (tab === "rank" ? rows[0] : analysisRows[0])?.scoring_benchmark;
  const maxVal = Math.max(...rows.map((r) => (r as any)[metric] || 0), 1);

  return (
    <div>
      <div className="page-title"><h1>Team Rank</h1></div>

      <div className="seg" style={{ marginBottom: 16 }}>
        <button type="button" className={tab === "rank" ? "on" : ""} onClick={() => setTab("rank")}>Rank</button>
        <button type="button" className={tab === "analysis" ? "on" : ""} onClick={() => setTab("analysis")}>Data Analysis</button>
      </div>

      {reference?.team != null && reference.avg_points != null && (tab === "analysis" || ["defense_capability", "relative_scoring"].includes(metric)) && (
        <p className="faint">Scoring reference: Team {reference.team} · {num(reference.avg_points, 2)} Haze Power Rating. Defense and relative scoring use this event leader.</p>
      )}
      {tab === "rank" ? (
      <>
      <div className="card" style={{ marginBottom: 16 }}>
        <label className="field" style={{ margin: 0, maxWidth: 320 }}>
          <span>Rank by</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>
            {metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
      </div>

      {loading ? <Loading /> : rows.length === 0 ? <Empty icon="chart" title="No data yet" /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th className="sticky-col sticky-rank">#</th><th className="sticky-col sticky-team">Team</th><th className="num"><MetricLabel metric={metric}>{metrics.find((m) => m.key === metric)?.label}</MetricLabel></th><th style={{ width: "30%" }}></th><th className="num"><MetricLabel metric="matches">Matches</MetricLabel></th><th className="num"><MetricLabel metric="avg_points">Haze Power Rating</MetricLabel></th><th className="num"><MetricLabel metric="consistency">Consist.</MetricLabel></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.team}>
                    <td className="sticky-col sticky-rank"><span className={rankClass(r.rank || 0)}>{r.rank}</span></td>
                    <td className="sticky-col sticky-team"><ClickableTeam team={r} /></td>
                    <td className="num mono"><b>{(r as any)[metric] == null ? "—" : fmt((r as any)[metric])}</b></td>
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
      </>
      ) : analysisLoading ? <Loading /> : analysisError && sortedAnalysisRows.length === 0 ? <div className="card" role="alert">{analysisError} <button className="btn ghost" onClick={loadAnalysis}>Retry</button></div> : sortedAnalysisRows.length === 0 ? <Empty icon="chart" title="No data yet" /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="team-col sticky-col sticky-team-first">Team</th>
                  {ANALYSIS_COLUMNS.map((col) => (
                    <th key={col.key} className="num">
                      <SortHeader
                        label={col.label}
                        active={analysisSort.key === col.key}
                        dir={analysisSort.dir}
                        onClick={() => setSort(col.key)}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedAnalysisRows.map((r) => (
                  <tr key={r.team}>
                    <td className="team-col sticky-col sticky-team-first"><ClickableTeam team={{ team_number: r.team, nickname: r.nickname, avatar: r.avatar }} /></td>
                    {ANALYSIS_COLUMNS.map((col) => (
                      <td key={col.key} className="num mono">{formatAnalysisValue(r, col.key)}</td>
                    ))}
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
