"use client";
import { useCallback, useState } from "react";
import { useLiveRefetch } from "@/lib/bus";
import { MetricLabel } from "./MetricLabel";
import { api } from "@/lib/api";
import { matchLabel, num, pct, timeAgo } from "@/lib/format";
import type { HeatPoint, Team, TeamSummary } from "@/lib/types";
import { Empty, Loading, Modal, Stat, TeamIdentity } from "@/components/ui";
import { FieldHeatmap } from "@/components/Field";
import { LineChart } from "@/components/Chart";
import { HazeIntel, TagCloud } from "@/components/Insight";

type TeamLike = Pick<Team, "team_number"> & Partial<Team>;

interface TeamReport {
  id: number;
  match_number: number;
  comp_level: string;
  alliance: "red" | "blue";
  station: number;
  scout_name: string;
  points: number;
  auto_leave: boolean;
  auto_climb: boolean;
  climb: string;
  played_defense: boolean;
  defense_rating: number;
  defense_on: string;
  successful_stops: number;
  driver_skill: number;
  speed_rating: number;
  fouls: number;
  failure: boolean;
  failure_details: string;
  no_show?: boolean;
  notes: string;
  tags?: string[];
  created_at: string;
}

interface TeamDetail {
  summary: TeamSummary;
  heatmap: { points: HeatPoint[]; total: number; made: number; accuracy: number };
  reports: TeamReport[];
  heatmaps?: Record<string, { points: HeatPoint[]; total: number; made: number; accuracy: number }>;
}

export function TeamDetailModal({ teamNumber, onClose }: { teamNumber: number; onClose: () => void }) {
  const [data, setData] = useState<TeamDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api<TeamDetail>(`/api/teams/${teamNumber}/scouting`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [teamNumber]);
  useLiveRefetch(load);

  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <h2>Team {teamNumber}</h2>
        <button className="btn sm ghost" onClick={onClose}>Close</button>
      </div>
      {loading ? <Loading /> : !data ? (
        <Empty title="Could not load team data" />
      ) : data.summary.matches === 0 ? (
        <Empty title={`No scouting data for ${teamNumber}`} />
      ) : (
        <TeamDetailBody data={data} />
      )}
    </Modal>
  );
}

export function ClickableTeam({
  team,
  size = "sm",
  showNickname = true,
}: {
  team: TeamLike | TeamSummary;
  size?: "sm" | "lg" | "";
  showNickname?: boolean;
}) {
  const teamNumber = "team_number" in team ? team.team_number : team.team;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="team-click" type="button" onClick={() => setOpen(true)}>
        <TeamIdentity team={"team_number" in team ? team : { ...team, team_number: team.team }} size={size} showNickname={showNickname} />
      </button>
      {open && <TeamDetailModal teamNumber={teamNumber} onClose={() => setOpen(false)} />}
    </>
  );
}

function TeamDetailBody({ data }: { data: TeamDetail }) {
  const { summary, reports } = data;
  const [phase, setPhase] = useState("all");
  const heatmap = data.heatmaps?.[phase] || data.heatmap;
  return (
    <div className="team-detail">
      <div className="card tight">
        <TeamIdentity team={summary} size="lg" />
        <TagCloud tags={summary.tags} />
      </div>

      <HazeIntel teamNumber={summary.team} />

      <div className="grid cols-4">
        <Stat label="Matches" value={summary.matches} />
        <Stat label="Avg Points" value={num(summary.avg_points)} accent />
        <Stat label="Consistency" value={pct(summary.consistency)} />
        <Stat label="EPA" value={summary.epa != null ? num(summary.epa, 0) : "-"} />
      </div>

      <div className="grid cols-2">
        <div className="card tight">
          <div className="card-h"><h3>Performance Trend</h3></div>
          <LineChart data={summary.match_points.map((m) => ({ x: `${m.comp_level && m.comp_level !== "qm" ? m.comp_level.toUpperCase() : "Q"}${m.match}`, y: m.points }))} height={150} label="Points per match" />
        </div>
        <div className="card tight">
          <div className="card-h"><h3>Scoring Heatmap</h3><div className="seg" aria-label="Scoring phase">{["all", "auto", "teleop"].map(p => <button key={p} className={phase === p ? "on" : ""} onClick={() => setPhase(p)}>{p === "all" ? "Both" : p === "auto" ? "Auto" : "Teleop"}</button>)}</div></div>
          {heatmap.points.length ? (
            <>
              <FieldHeatmap points={heatmap.points} stats={heatmap} />
            </>
          ) : <Empty title="No mapped scoring" />}
        </div>
      </div>

      <div className="grid cols-4">
        <Stat label="Peak" value={num(summary.max_points)} />
        <Stat label="Climb Rate" value={pct(summary.climb_rate)} />
        <Stat label="Failure Rate" value={pct(summary.failure_rate)} />
        <Stat label="Defense Stops" value={summary.total_stops} />
      </div>

      <div className="card tight">
        <div className="card-h">
          <h3>Scouter Reports</h3>
          <span className="badge muted">{reports.length}</span>
        </div>
        {reports.length === 0 ? <Empty title="No scouter reports" /> : (
          <div className="grid" style={{ gap: 10 }}>
            {reports.slice(0, 8).map((r) => (
              <article key={r.id} className={`card tight ${r.alliance === "red" ? "alliance-red" : "alliance-blue"}`}>
                <div className="spread" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <b>{matchLabel(r.comp_level, r.match_number)}</b>
                      <span className={`badge ${r.alliance}`}>{r.alliance.toUpperCase()} {r.station}</span>
                      <span className="badge haze">{num(r.points)} pts</span>
                    </div>
                    <div className="faint" style={{ fontSize: "0.75rem", marginTop: 4 }}>
                      {r.scout_name} · {timeAgo(r.created_at)}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                    <span className="badge muted">Climb {r.climb.toUpperCase()}</span>
                    <span className="badge muted">Driver {num(r.driver_skill)}/5</span>
                    <span className="badge muted">Speed {num(r.speed_rating)}/5</span>
                    {r.fouls > 0 && <span className="badge amber">{r.fouls} fouls</span>}
                    {r.failure && <span className="badge red">Failure</span>}
                    {r.no_show && <span className="badge red">No show</span>}
                  </div>
                </div>
                {r.tags && r.tags.length > 0 && (
                  <div className="tag-list" style={{ marginTop: 8 }}>
                    {r.tags.map((t) => <span key={t} className="chip static sm">{t}</span>)}
                  </div>
                )}
                <div className="report-grid">
                  <div>
                    <span className="faint">Autonomous</span>
                    <p>{r.auto_leave ? "Left starting area" : "No auto leave"}{r.auto_climb ? " · auto climb" : ""}</p>
                  </div>
                  <div>
                    <span className="faint">Defense</span>
                    <p>{r.played_defense ? `Played defense (${r.defense_rating}/5), ${r.successful_stops} stops${r.defense_on ? ` on ${r.defense_on}` : ""}` : "No defense noted"}</p>
                  </div>
                  <div>
                    <span className="faint">Failure Details</span>
                    <p>{r.failure ? (r.failure_details || "Failure marked, no details") : "No failure"}</p>
                  </div>
                  <div>
                    <span className="faint">Scouter Comments</span>
                    <p>{r.notes || "No comments"}</p>
                  </div>
                </div>
              </article>
            ))}
            {reports.length > 8 && <p className="faint" style={{ margin: 0 }}>Showing 8 of {reports.length} reports. Use Team Search for the full list.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
