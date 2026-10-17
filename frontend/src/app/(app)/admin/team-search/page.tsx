"use client";
import { useEffect, useState, useCallback } from "react";
import { useLiveRefetch } from "@/lib/bus";
import { api } from "@/lib/api";
import { matchLabel, num, pct, timeAgo } from "@/lib/format";
import type { Team, TeamSummary, HeatPoint, PitEntry } from "@/lib/types";
import { Loading, Empty, Modal, Stat, TeamIdentity } from "@/components/ui";
import { FieldHeatmap } from "@/components/Field";
import { LineChart } from "@/components/Chart";

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
  climb_seconds?: number | null;
  played_defense: boolean;
  defense_rating: number;
  defense_on: string;
  successful_stops: number;
  driver_skill: number;
  speed_rating: number;
  fouls: number;
  failure: boolean;
  failure_details: string;
  notes: string;
  created_at: string;
}

export default function TeamSearchPage() {
  const [teams, setTeams] = useState<number[]>([]);
  const [teamProfiles, setTeamProfiles] = useState<Record<number, Team>>({});
  const [team, setTeam] = useState<number | null>(null);
  const [summary, setSummary] = useState<TeamSummary | null>(null);
  const [heat, setHeat] = useState<{ points: HeatPoint[]; total: number; made: number; accuracy: number } | null>(null);
  const [reports, setReports] = useState<TeamReport[]>([]);
  const [pit, setPit] = useState<PitEntry | null>(null);
  // The scoring map filters by phase and driver station itself now.
  const phase = "" as "" | "auto" | "teleop";
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api<number[]>("/api/admin/event-teams").then((t) => { setTeams(t); if (t[0]) selectTeam(t[0]); }).catch(() => {});
  }, []);

  useEffect(() => {
    const nums = teams.filter((n) => n && !teamProfiles[n]);
    if (!nums.length) return;
    api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: nums } })
      .then((rows) => setTeamProfiles((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) })))
      .catch(() => {});
  }, [teams, teamProfiles]);

  const selectTeam = useCallback(async (n: number) => {
    setTeam(n); setLoading(true); setSummary(null); setHeat(null); setReports([]); setPit(null);
    const [s, h, r, p] = await Promise.allSettled([
        api<TeamSummary>(`/api/admin/team/${n}/summary`),
        api<any>(`/api/admin/team/${n}/heatmap`),
        api<TeamReport[]>(`/api/admin/team/${n}/reports`),
        api<PitEntry | null>(`/api/pit/${n}`),
    ]);
    if (s.status === "fulfilled") setSummary(s.value);
    if (h.status === "fulfilled") setHeat(h.value);
    if (r.status === "fulfilled") setReports(r.value);
    if (p.status === "fulfilled") setPit(p.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!team) return;
    const q = phase ? `?phase=${phase}` : "";
    api<any>(`/api/admin/team/${team}/heatmap${q}`).then(setHeat).catch(() => {});
  }, [phase, team]);

  useLiveRefetch(useCallback(() => { if (team) void selectTeam(team); }, [team, selectTeam]));

  return (
    <div>
      <div className="page-title"><h1>Team Search</h1></div>

      <div className="card team-name-white" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Team #" style={{ maxWidth: 160 }}
            onKeyDown={(e) => { if (e.key === "Enter") { const n = parseInt(query.replace(/[^0-9]/g, ""), 10); if (n) selectTeam(n); } }} />
          <button className="btn" onClick={() => { const n = parseInt(query.replace(/[^0-9]/g, ""), 10); if (n) selectTeam(n); }}>Search</button>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {teams.map((t) => (
            <button key={t} className={"chip" + (team === t ? " on" : "")} onClick={() => selectTeam(t)}>
              <TeamIdentity team={teamProfiles[t] || { team_number: t, nickname: "" }} showNickname={false} />
            </button>
          ))}
          {!teams.length && <span className="faint">No scouted teams yet.</span>}
        </div>
      </div>

      {loading ? <Loading /> : !summary ? (
        <Empty icon="bot" title="Search a team" />
      ) : summary.matches === 0 ? (
        <>
          <div className="card team-name-white" style={{ marginBottom: 16 }}><TeamIdentity team={summary} size="lg" /></div>
          <PitShowcase pit={pit} team={team || 0} />
          <Empty icon="inbox" title={`No match scouting data for ${team}`} />
        </>
      ) : (
        <>
          <div className="card team-name-white" style={{ marginBottom: 16 }}>
            <TeamIdentity team={summary} size="lg" />
          </div>
          <PitShowcase pit={pit} team={team || 0} />

          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <Stat label="Matches" value={summary.matches} />
            <Stat label="Haze Power Rating" value={num(summary.avg_points)} accent />
            <Stat label="Consistency" value={pct(summary.consistency)} />
            <Stat label="EPA" value={summary.epa != null ? num(summary.epa, 0) : "-"} />
          </div>

          <div className="grid cols-2">
            <div className="card">
              <div className="card-h"><h3>Scoring Map</h3></div>
              {/* The map now carries its own phase and driver-station filters,
                  so the page-level phase toggle above it would just be a
                  second control for the same thing. */}
              {heat && heat.points.length > 0 ? (
                <FieldHeatmap stats={heat} points={heat.points} />
              ) : <Empty icon="map" title="No mapped scoring" />}
            </div>

            <div className="card">
              <div className="card-h"><h3>Performance Trend</h3></div>
              <LineChart data={summary.match_points.map((m) => ({ x: `${m.comp_level && m.comp_level !== "qm" ? m.comp_level.toUpperCase() : "Q"}${m.match}`, y: m.points }))} label="Points per match" />
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

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-h">
              <h3>Scouter Reports</h3>
              <span className="badge muted">{reports.length} entries</span>
            </div>
            {reports.length === 0 ? (
              <Empty icon="clipboard" title="No scouter reports" />
            ) : (
              <div className="grid" style={{ gap: 10 }}>
                {reports.map((r) => (
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
                      </div>
                    </div>

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
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PitShowcase({ pit, team }: { pit: PitEntry | null; team: number }) {
  const [openPhoto, setOpenPhoto] = useState<number | null>(null);
  if (!pit) return <section className="card" style={{ marginBottom: 16 }}><h3>Pit Scouting</h3><p className="faint">No pit report for Team {team}.</p></section>;
  const photos = Array.from(new Set([...(pit.robot_photos || []), ...(pit.robot_photo ? [pit.robot_photo] : [])]));
  const details = ([
    ["Drivetrain", pit.drivetrain], ["Archetype", pit.archetype], ["Weight", pit.weight_lbs ? `${pit.weight_lbs} lb` : ""],
    ["Width", pit.width_in ? `${pit.width_in} in` : ""], ["Length", pit.length_in ? `${pit.length_in} in` : ""],
    ["Climb", pit.can_climb], ["Auto routine", pit.auto_routine], ["Notes", pit.notes],
  ] as [string, any][]).filter(([, value]) => value !== "" && value !== null && value !== undefined);
  return <section className="card" style={{ marginBottom: 16 }}>
    <div className="card-h"><h3>Pit Scouting</h3><span className="badge muted">{photos.length} photo{photos.length === 1 ? "" : "s"}</span></div>
    {!!photos.length && <div className="pit-photo-grid">{photos.map((photo, index) => <figure key={index}><button type="button" className="pit-photo-button" aria-label={`Open pit photo ${index + 1} full size`} onClick={() => setOpenPhoto(index)}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={photo} alt={`Team ${team} robot ${index + 1}`} /><span>Open full size</span></button></figure>)}</div>}
    <div className="report-grid" style={{ marginTop: 12 }}>{details.map(([label, value]) => <div key={label}><span className="faint">{label}</span><p>{String(value)}</p></div>)}</div>
    {!!pit.capabilities?.length && <div className="tag-list">{pit.capabilities.map(value => <span className="chip" key={value}>{value}</span>)}</div>}
    {!!pit.responses && Object.keys(pit.responses).length > 0 && <><h4>All pit form answers</h4><div className="report-grid">{Object.entries(pit.responses).map(([key, value]) => <div key={key}><span className="faint">{key.replaceAll("_", " ")}</span><p>{Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value || "—")}</p></div>)}</div></>}
    {openPhoto !== null && <Modal dialog onClose={() => setOpenPhoto(null)}><div className="pit-photo-viewer"><div className="modal-head"><div><h2 style={{ margin: 0 }}>Team {team}</h2><span className="faint">Pit photo {openPhoto + 1} of {photos.length}</span></div><button type="button" className="btn" onClick={() => setOpenPhoto(null)}>Close</button></div>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={photos[openPhoto]} alt={`Team ${team} robot full size ${openPhoto + 1}`} />{photos.length > 1 && <div className="btn-row" style={{ justifyContent: "center" }}><button type="button" className="btn" onClick={() => setOpenPhoto((openPhoto - 1 + photos.length) % photos.length)}>Previous</button><button type="button" className="btn primary" onClick={() => setOpenPhoto((openPhoto + 1) % photos.length)}>Next</button></div>}</div></Modal>}
  </section>;
}
