"use client";
import { useCallback, useEffect, useState } from "react";
import { METRICS } from "@/lib/metrics";
import { api } from "@/lib/api";
import { useLiveRefetch } from "@/lib/bus";
import { num } from "@/lib/format";
import type { Team, TeamSummary } from "@/lib/types";
import { Loading, Empty, TeamIdentity } from "@/components/ui";
import { FieldHeatmap, OverlayHeatmap } from "@/components/Field";

interface CompareData {
  teams: TeamSummary[];
  metrics: { key: string; label: string; better: string; values: { team: number; value: number; best: boolean }[] }[];
}

const SLOTS = 6;

export default function ComparePage() {
  const [available, setAvailable] = useState<number[]>([]);
  const [teamProfiles, setTeamProfiles] = useState<Record<number, Team>>({});
  // Fixed dropdown slots, like the Google Sheet, no free typing.
  const [slots, setSlots] = useState<(number | null)[]>(Array(SLOTS).fill(null));
  const [data, setData] = useState<CompareData | null>(null);
  const [heats, setHeats] = useState<Record<number, any>>({});
  const [loading, setLoading] = useState(false);

  const loadTeams = useCallback(() => {
    api<number[]>("/api/admin/event-teams").then(setAvailable).catch(() => {});
  }, []);
  useLiveRefetch(loadTeams, ["settings_changed", "scout_submitted", "match_advanced"]);

  useEffect(() => {
    const nums = available.filter((n) => n && !teamProfiles[n]);
    if (!nums.length) return;
    api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: nums } })
      .then((rows) => setTeamProfiles((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) })))
      .catch(() => {});
  }, [available, teamProfiles]);

  const selected = slots.filter((n): n is number => n != null);

  function setSlot(i: number, value: string) {
    const n = value ? parseInt(value, 10) : null;
    setSlots((cur) => cur.map((v, k) => (k === i ? n : v)));
  }

  useLiveRefetch(useCallback(() => {
    if (selected.length < 2) { setData(null); return; }
    setLoading(true);
    api<CompareData>(`/api/admin/compare?teams=${selected.join(",")}`).then(setData).catch(() => {}).finally(() => setLoading(false));
    selected.forEach((n) => {
      api<any>(`/api/admin/team/${n}/heatmap`).then((h) => setHeats((x) => ({ ...x, [n]: h }))).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.join(",")]));

  const fmt = (key: string, v: number) => v == null ? "—" : METRICS[key]?.percent ? `${(v * 100).toFixed(0)}%` : num(v, key === "epa" || key.includes("foul") ? 0 : 1);
  const reference = data?.teams[0]?.scoring_benchmark;
  const label = (t: number) => `${t}${teamProfiles[t]?.nickname ? `. ${teamProfiles[t].nickname}` : ""}`;

  return (
    <div>
      <div className="page-title"><h1>Compare Robots</h1></div>
      {reference?.team != null && reference.avg_points != null && <p className="faint">Scoring reference: Team {reference.team} · {num(reference.avg_points, 2)} Haze Power Rating. Defense and relative scoring use this event leader.</p>}


      <div className="card" style={{ marginBottom: 16 }}>
        {available.length === 0 ? (
          <Empty icon="scale" title="No teams at this event yet" />
        ) : (
          <div className="compare-slots">
            {slots.map((val, i) => (
              <label key={i} className="field compare-slot">
                <span>Robot {i + 1}{i < 2 ? "" : " (optional)"}</span>
                <select value={val ?? ""} onChange={(e) => setSlot(i, e.target.value)}>
                  <option value="">. pick a team. </option>
                  {available
                    .filter((t) => t === val || !selected.includes(t))
                    .map((t) => (
                      <option key={t} value={t}>{label(t)}</option>
                    ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>

      {selected.length < 2 ? (
        <Empty icon="scale" title="Pick at least 2 robots" sub="Use the dropdowns above, the list comes straight from the event." />
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
                  <tr><td className="muted">Nickname</td>{data.teams.map((t) => <td key={t.team} className="num faint">{t.nickname || "-"}</td>)}</tr>
                  <tr><td className="muted">Matches</td>{data.teams.map((t) => <td key={t.team} className="num mono">{t.matches}</td>)}</tr>
                  {data.metrics.map((row) => (
                    <tr key={row.key}>
                      <td className="muted">{row.label}</td>
                      {row.values.map((v) => (
                        <td key={v.team} className="num mono" style={v.best ? { fontWeight: 700 } : {}}>
                          {fmt(row.key, v.value)}{v.best ? " ★" : ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <section className="card compare-overlay-card" style={{ marginBottom: 16 }}>
            <div className="card-h">
              <div>
                <h2>Heatmap Overlay</h2>
                <p className="faint">Overlay up to six robots, then filter their combined field by match phase and driver station.</p>
              </div>
              <span className="badge haze">Up to 6 teams</span>
            </div>
            <OverlayHeatmap
              series={data.teams.map((team) => ({
                team: team.team,
                label: label(team.team),
                points: heats[team.team]?.points || [],
              }))}
            />
          </section>

          <div className="grid auto">
            {data.teams.map((t) => (
              <div key={t.team} className="card tight">
                <div className="card-h"><h3 style={{ fontSize: "0.95rem" }}>{t.team} heatmap</h3></div>
                {heats[t.team]?.points?.length ? <FieldHeatmap stats={heats[t.team]} points={heats[t.team].points} height={150} /> : <Empty icon="map" title="No map" />}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
