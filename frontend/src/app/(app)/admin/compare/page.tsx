"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { num } from "@/lib/format";
import type { Team, TeamSummary } from "@/lib/types";
import { Loading, Empty, TeamIdentity } from "@/components/ui";
import { FieldHeatmap } from "@/components/Field";

interface CompareData {
  teams: TeamSummary[];
  metrics: { key: string; label: string; better: string; values: { team: number; value: number; best: boolean }[] }[];
}

export default function ComparePage() {
  const [available, setAvailable] = useState<number[]>([]);
  const [teamProfiles, setTeamProfiles] = useState<Record<number, Team>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [data, setData] = useState<CompareData | null>(null);
  const [heats, setHeats] = useState<Record<number, any>>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<number[]>("/api/admin/event-teams").then(setAvailable).catch(() => {});
  }, []);

  useEffect(() => {
    const nums = available.filter((n) => n && !teamProfiles[n]);
    if (!nums.length) return;
    api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: nums } })
      .then((rows) => setTeamProfiles((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) })))
      .catch(() => {});
  }, [available, teamProfiles]);

  function toggle(n: number) {
    setSelected((s) => s.includes(n) ? s.filter((x) => x !== n) : s.length < 6 ? [...s, n] : s);
  }

  useEffect(() => {
    if (selected.length < 2) { setData(null); return; }
    setLoading(true);
    api<CompareData>(`/api/admin/compare?teams=${selected.join(",")}`).then(setData).catch(() => {}).finally(() => setLoading(false));
    selected.forEach((n) => {
      if (!heats[n]) api<any>(`/api/admin/team/${n}/heatmap`).then((h) => setHeats((x) => ({ ...x, [n]: h }))).catch(() => {});
    });
  }, [selected]);

  const fmt = (key: string, v: number) => key.includes("rate") || key === "consistency" ? `${(v * 100).toFixed(0)}%` : num(v, key === "epa" || key.includes("foul") ? 0 : 1);

  return (
    <div>
      <div className="page-title"><h1>Compare Robots</h1></div>
      <p className="page-sub">Add 2–6 robots for a side-by-side breakdown. Best value in each row is highlighted.</p>

      <div className="card team-name-white" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Add team #" style={{ maxWidth: 150 }}
            onKeyDown={(e) => { if (e.key === "Enter") { const n = parseInt(input.replace(/[^0-9]/g, ""), 10); if (n) { toggle(n); setInput(""); } } }} />
          <button className="btn" onClick={() => { const n = parseInt(input.replace(/[^0-9]/g, ""), 10); if (n) { toggle(n); setInput(""); } }}>Add</button>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {available.map((t) => (
            <button key={t} className={"chip" + (selected.includes(t) ? " on" : "")} onClick={() => toggle(t)}>
              <TeamIdentity team={teamProfiles[t] || { team_number: t, nickname: "" }} showNickname={false} />
            </button>
          ))}
        </div>
      </div>

      {selected.length < 2 ? (
        <Empty icon="scale" title="Pick at least 2 robots" sub="Select teams above to compare them." />
      ) : loading || !data ? <Loading /> : (
        <>
          <div className="card team-name-white" style={{ marginBottom: 16 }}>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Metric</th>
                    {data.teams.map((t) => (
                      <th key={t.team} className="num">
                        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                          <TeamIdentity team={t} showNickname={false} />
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="muted">Nickname</td>{data.teams.map((t) => <td key={t.team} className="num faint">{t.nickname || "—"}</td>)}</tr>
                  <tr><td className="muted">Matches</td>{data.teams.map((t) => <td key={t.team} className="num mono">{t.matches}</td>)}</tr>
                  {data.metrics.map((row) => (
                    <tr key={row.key}>
                      <td className="muted">{row.label}</td>
                      {row.values.map((v) => (
                        <td key={v.team} className="num mono" style={v.best ? { color: "var(--haze-glow)", fontWeight: 800, background: "rgba(102,51,153,0.18)" } : {}}>
                          {fmt(row.key, v.value)}{v.best ? " ★" : ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid auto">
            {data.teams.map((t) => (
              <div key={t.team} className="card tight">
                <div className="card-h"><h3 style={{ fontSize: "0.95rem" }}>{t.team} heatmap</h3></div>
                {heats[t.team]?.points?.length ? <FieldHeatmap points={heats[t.team].points} height={150} /> : <Empty icon="map" title="No map" />}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
