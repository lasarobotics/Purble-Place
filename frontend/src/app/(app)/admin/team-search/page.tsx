"use client";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { num, pct } from "@/lib/format";
import type { TeamSummary, HeatPoint } from "@/lib/types";
import { Loading, Empty, Stat } from "@/components/ui";
import { FieldHeatmap } from "@/components/Field";
import { LineChart } from "@/components/Chart";

export default function TeamSearchPage() {
  const [teams, setTeams] = useState<number[]>([]);
  const [team, setTeam] = useState<number | null>(null);
  const [summary, setSummary] = useState<TeamSummary | null>(null);
  const [heat, setHeat] = useState<{ points: HeatPoint[]; total: number; made: number; accuracy: number } | null>(null);
  const [phase, setPhase] = useState<"" | "auto" | "teleop">("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api<number[]>("/api/admin/event-teams").then((t) => { setTeams(t); if (t[0]) selectTeam(t[0]); }).catch(() => {});
  }, []);

  const selectTeam = useCallback(async (n: number) => {
    setTeam(n); setLoading(true);
    try {
      const [s, h] = await Promise.all([
        api<TeamSummary>(`/api/admin/team/${n}/summary`),
        api<any>(`/api/admin/team/${n}/heatmap`),
      ]);
      setSummary(s); setHeat(h);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!team) return;
    const q = phase ? `?phase=${phase}` : "";
    api<any>(`/api/admin/team/${team}/heatmap${q}`).then(setHeat).catch(() => {});
  }, [phase, team]);

  return (
    <div>
      <div className="page-title"><h1>🔎 Team Search</h1></div>
      <p className="page-sub">Every match for a team, with a field heatmap of all their scoring positions.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Team #" style={{ maxWidth: 160 }}
            onKeyDown={(e) => { if (e.key === "Enter") { const n = parseInt(query.replace(/[^0-9]/g, ""), 10); if (n) selectTeam(n); } }} />
          <button className="btn" onClick={() => { const n = parseInt(query.replace(/[^0-9]/g, ""), 10); if (n) selectTeam(n); }}>Search</button>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {teams.map((t) => (
            <button key={t} className={"chip" + (team === t ? " on" : "")} onClick={() => selectTeam(t)}>{t}</button>
          ))}
          {!teams.length && <span className="faint">No scouted teams yet.</span>}
        </div>
      </div>

      {loading ? <Loading /> : !summary ? (
        <Empty icon="🤖" title="Search a team" sub="Pick a team above to see their data." />
      ) : summary.matches === 0 ? (
        <Empty icon="📭" title={`No scouting data for ${team}`} />
      ) : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <Stat label="Matches" value={summary.matches} />
            <Stat label="Avg Points" value={num(summary.avg_points)} accent />
            <Stat label="Consistency" value={pct(summary.consistency)} />
            <Stat label="EPA" value={summary.epa != null ? num(summary.epa, 0) : "—"} />
          </div>

          <div className="grid cols-2">
            <div className="card">
              <div className="card-h"><h3>Scoring Heatmap</h3>
                <div className="seg">
                  <button className={phase === "" ? "on" : ""} onClick={() => setPhase("")}>All</button>
                  <button className={phase === "auto" ? "on" : ""} onClick={() => setPhase("auto")}>Auto</button>
                  <button className={phase === "teleop" ? "on" : ""} onClick={() => setPhase("teleop")}>Teleop</button>
                </div>
              </div>
              {heat && heat.points.length > 0 ? (
                <>
                  <FieldHeatmap points={heat.points} />
                  <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
                    <span className="badge muted">{heat.total} attempts</span>
                    <span className="badge green">{heat.made} made</span>
                    <span className="badge haze">{pct(heat.accuracy)} accuracy</span>
                  </div>
                </>
              ) : <Empty icon="🗺️" title="No mapped scoring" />}
            </div>

            <div className="card">
              <div className="card-h"><h3>Performance Trend</h3></div>
              <LineChart data={summary.match_points.map((m) => ({ x: `Q${m.match}`, y: m.points }))} label="Points per match" />
              <div className="divider" />
              <div className="grid cols-2" style={{ gap: 10 }}>
                <Stat label="Peak" value={num(summary.max_points)} />
                <Stat label="Floor" value={num(summary.min_points)} />
                <Stat label="Climb rate" value={pct(summary.climb_rate)} />
                <Stat label="Failure rate" value={pct(summary.failure_rate)} />
                <Stat label="Driver" value={`${num(summary.avg_driver)}/5`} />
                <Stat label="Defense stops" value={summary.total_stops} />
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-h"><h3>Scoring Breakdown</h3></div>
            <div className="grid cols-4">
              <Stat label="Auto made" value={summary.counts.auto_made} />
              <Stat label="Auto missed" value={summary.counts.auto_missed} />
              <Stat label="Teleop made" value={summary.counts.teleop_made} />
              <Stat label="Teleop missed" value={summary.counts.teleop_missed} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
