"use client";
import { useCallback, useMemo, useState, useRef } from "react";
import { api } from "@/lib/api";
import { useLiveRefetch } from "@/lib/bus";
import { MetricLabel } from "./MetricLabel";
import { ClickableTeam } from "./TeamDetailModal";
import { Empty, Loading } from "./ui";
import { num, pct } from "@/lib/format";

export type AnalysisRow = {
  team: number; nickname?: string; matches: number; avg_points?: number | null;
  opr?: number | null; match13_epa?: number | null; xp?: number | null;
  x_auto?: number | null; x_tele?: number | null; x_end?: number | null;
  record?: string; ranking_score?: number | null; avg_score?: number | null; match13_sos?: number | null;
  defense_capability: number | null; consistency: number; skew_distribution: number | null;
  failure_rate: number; foul_match_rate: number; climb_success_rate: number;
  ranking_point_prediction: number | null;
};
type Row = AnalysisRow;
const columns: { key: keyof Row; label: string; format: (value: any) => string }[] = [
  { key: "avg_points", label: "Haze Power Rating", format: v => num(v, 1) },
  { key: "opr", label: "OPR", format: v => num(v, 1) },
  { key: "match13_epa", label: "EPA", format: v => num(v, 1) },
  { key: "xp", label: "xP", format: v => num(v, 1) },
  { key: "x_auto", label: "xAuto", format: v => num(v, 1) },
  { key: "x_tele", label: "xTele", format: v => num(v, 1) },
  { key: "x_end", label: "xEnd", format: v => num(v, 1) },
  { key: "record", label: "Record", format: v => String(v) },
  { key: "ranking_score", label: "RS", format: v => num(v, 2) },
  { key: "avg_score", label: "Avg", format: v => num(v, 1) },
  { key: "match13_sos", label: "SOS", format: v => num(v, 3) },
  { key: "defense_capability", label: "Defense Capability", format: v => num(v, 2) },
  { key: "consistency", label: "Consistency", format: pct },
  { key: "skew_distribution", label: "Skew Distribution", format: v => num(v, 3) },
  { key: "failure_rate", label: "Failure Rate", format: pct },
  { key: "foul_match_rate", label: "Foul Match Rate", format: pct },
  { key: "climb_success_rate", label: "Climb Success Rate", format: pct },
  { key: "ranking_point_prediction", label: "Ranking Point Prediction", format: v => num(v, 1) },
];

export function DataAnalysisPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sort, setSort] = useState<keyof Row>("xp");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const started = ++generation.current;
    try {
      const analysis = await api<{ teams: Row[] }>("/api/admin/data-analysis");
      if (started !== generation.current) return;
      setError("");
      setRows(analysis.teams);
      // External ratings enrich the already-visible table. A slow or missing
      // Match 13 response must never hold scouting data behind a spinner.
      void api<{ teams: Partial<Row>[] }>("/api/matches/event-ratings").then(external => {
        if (started !== generation.current) return;
        setRows(current => {
          const merged = new Map((current || analysis.teams).map(row => [row.team, row]));
          for (const rating of external.teams) {
            const team = Number(rating.team); const row = merged.get(team);
            if (row) merged.set(team, { ...row, ...rating });
            else merged.set(team, { team, nickname: "", matches: 0, defense_capability: null,
              consistency: 0, skew_distribution: null, failure_rate: 0, foul_match_rate: 0,
              climb_success_rate: 0, ranking_point_prediction: null, ...rating });
          }
          return [...merged.values()];
        });
      }).catch(() => {});
    } catch { if (started === generation.current) setError("Data Analysis could not refresh. Your session and saved scouting data are unchanged."); }
  }, []);
  useLiveRefetch(load);
  const sorted = useMemo(() => [...(rows || [])].sort((a, b) => sort === "record"
    ? String(b.record || "").localeCompare(String(a.record || ""), undefined, { numeric: true })
    : Number(b[sort] ?? -Infinity) - Number(a[sort] ?? -Infinity)), [rows, sort]);
  if (!rows && error) return <div className="card" role="alert">{error} <button className="btn ghost" onClick={load}>Retry</button></div>;
  if (!rows) return <Loading />;
  if (!rows.length) return <Empty title="No event data yet" />;
  return <div className="table-wrap analysis-panel-table"><table className="data"><thead><tr><th>Team</th><th>Matches</th>{columns.map(column => <th className="num" key={column.key}><button className="analysis-sort" onClick={() => setSort(column.key)}><MetricLabel metric={String(column.key)}>{column.label}</MetricLabel>{sort === column.key ? " ↓" : ""}</button></th>)}</tr></thead><tbody>{sorted.map(row => <tr key={row.team}><td><ClickableTeam team={{ team_number: row.team, nickname: row.nickname || "" }} /></td><td className="num">{row.matches}</td>{columns.map(column => { const value = row[column.key]; const present = (typeof value === "number" && Number.isFinite(value)) || typeof value === "string"; return <td className="num mono" key={column.key}>{present ? column.format(value) : "—"}</td>; })}</tr>)}</tbody></table></div>;
}
