"use client";
import { useMemo } from "react";
import { useSchedule } from "@/lib/schedule";
import type { MatchRec } from "@/lib/types";
import { Empty, Loading } from "./ui";

const HOME = new Set([418, 436]);

function timeLabel(value?: number | null) {
  if (!value) return "Time TBD";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value * 1000));
}

function Alliance({ color, teams, score, winner }: { color: "red" | "blue"; teams: number[]; score?: number | null; winner?: string | null }) {
  return <div className={`event-alliance ${color} ${winner === color ? "winner" : ""}`}>
    <span className="event-alliance-name">{color}</span>
    <span className="event-team-numbers">{teams.map(team => <b className={HOME.has(team) ? "home-team" : ""} key={team}>{team}</b>)}</span>
    <strong className="event-score">{score == null ? "—" : score}</strong>
  </div>;
}

function MatchCard({ match, results }: { match: MatchRec; results: boolean }) {
  const highlighted = [...match.red, ...match.blue].some(team => HOME.has(team));
  return <article className={`event-match-card${highlighted ? " highlighted" : ""}`}>
    <header><div><b>Qualification {match.match_number}</b><span>{timeLabel(match.predicted_time)}</span></div>{highlighted && <span className="badge haze">418 / 436 match</span>}</header>
    <Alliance color="red" teams={match.red} score={results ? match.red_score : null} winner={match.winner} />
    <Alliance color="blue" teams={match.blue} score={results ? match.blue_score : null} winner={match.winner} />
  </article>;
}

export function EventMatchBoard({ mode }: { mode: "results" | "schedule" }) {
  const schedule = useSchedule();
  const quals = useMemo(() => schedule.matches.filter(match => match.comp_level === "qm").sort((a, b) => a.match_number - b.match_number), [schedule.matches]);
  const rows = mode === "results" ? quals.filter(match => match.red_score != null && match.blue_score != null).reverse() : quals;
  const featured = mode === "schedule" ? rows.filter(match => [...match.red, ...match.blue].some(team => HOME.has(team))) : [];
  if (schedule.loading) return <Loading label="Loading event matches…" />;
  if (!rows.length) return <Empty title={mode === "results" ? "No qualification results yet" : "No qualification schedule yet"} />;
  return <>
    <div className="event-board-meta"><span className="badge haze">{schedule.event}</span><span className="faint">{schedule.source === "cache" ? "Saved offline copy" : "Updates every minute"}</span><button className="btn sm" onClick={() => void schedule.refresh()}>Refresh</button></div>
    {featured.length > 0 && <section className="event-featured"><div className="card-h"><div><h2>418 & 436 matches</h2><p className="faint">Purple Haze and Purple Rain are highlighted throughout the schedule.</p></div></div><div className="event-match-grid">{featured.map(match => <MatchCard key={match.match_key} match={match} results={false} />)}</div></section>}
    <section><div className="card-h"><div><h2>{mode === "results" ? "Qualification results" : "Full qualification schedule"}</h2><p className="faint">{mode === "results" ? `${rows.length} scored matches` : `${rows.length} qualification matches`}</p></div></div><div className="event-match-grid">{rows.map(match => <MatchCard key={match.match_key} match={match} results={mode === "results"} />)}</div></section>
  </>;
}
