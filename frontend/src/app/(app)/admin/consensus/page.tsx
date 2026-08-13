"use client";
// Consensus Radar.
//
// The old version showed three percentile bars and a 0 to 1 "disagreement
// score" and left you to work out what any of it meant. Nobody in a picklist
// meeting has time for that. This version leads with a plain sentence saying
// what is wrong with each team's data and what to do about it, and keeps the
// numbers underneath for anyone who wants to check the reasoning.
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useLiveRefetch } from "@/lib/bus";
import { num } from "@/lib/format";
import type { DisagreementRow } from "@/lib/types";
import { Empty, Loading, Bar } from "@/components/ui";
import { ClickableTeam } from "@/components/TeamDetailModal";
import { Icon } from "@/components/icons";

/** One sentence per flag, written as advice rather than as a label. */
function explain(t: DisagreementRow): { headline: string; detail: string; cls: string } {
  if (t.flags.includes("scouts_disagree")) {
    return {
      cls: "amber",
      headline: "Two scouts saw this team very differently",
      detail:
        `In the same match their scores differed by ${num(t.max_spread, 1)} points. ` +
        `One of them probably missed cycles. Trust this team's averages less until you check the film.`,
    };
  }
  if (t.flags.includes("numbers_look_better_than_eyes")) {
    return {
      cls: "red",
      headline: "Scores better than it looks",
      detail:
        "It puts up points, but scouts rate the driving, reliability and tags poorly. " +
        "Often a robot carried by easy matches. Watch it before you pick it.",
    };
  }
  if (t.flags.includes("eyes_look_better_than_numbers")) {
    return {
      cls: "blue",
      headline: "Looks better than it scores",
      detail:
        "Scouts rate this robot highly but its point total is low. " +
        "Often a good defender, or a good robot stuck on bad alliances. Worth a second look.",
    };
  }
  return {
    cls: "green",
    headline: "Data is consistent",
    detail: "Scouts agree with each other and with the numbers. No reason to doubt this team's record.",
  };
}

export default function ConsensusPage() {
  const [data, setData] = useState<{ teams: DisagreementRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    api<{ teams: DisagreementRow[] }>("/api/admin/disagreements")
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);
  useLiveRefetch(load);

  if (loading) return <Loading label="Checking the scouting record" />;

  const teams = data?.teams ?? [];
  const flagged = teams.filter((t) => t.flags.length > 0);
  const shown = showAll || flagged.length === 0 ? teams : flagged;

  return (
    <div>
      <div className="page-title">
        <h1>Consensus Radar</h1>
        {flagged.length > 0 && <span className="badge amber">{flagged.length} to check</span>}
      </div>
      <p className="page-sub">
        Teams whose scouting data does not add up. Watch these on film before the
        picklist locks, because their numbers may not mean what they look like.
      </p>

      {teams.length === 0 ? (
        <div className="card">
          <Empty
            icon="radar"
            title="Nothing to check yet"
            sub="This fills in once a few matches have been scouted."
          />
        </div>
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          {flagged.length === 0 && (
            <div className="card tight">
              <p style={{ margin: 0 }}>
                <span className="dot green" style={{ marginRight: 8 }} />
                Every scouted team looks consistent so far. Nothing needs a second look.
              </p>
            </div>
          )}

          {shown.map((t) => {
            const expanded = open === t.team;
            const why = explain(t);
            return (
              <div key={t.team} className={"card tight consensus-row" + (t.flags.length ? " flagged" : "")}>
                <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
                  <ClickableTeam team={{ team_number: t.team, nickname: t.nickname, avatar: t.avatar }} />
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span className={`badge ${why.cls}`}>{why.headline}</span>
                    <span className="badge muted">{t.matches} matches</span>
                    <span className="badge muted">{num(t.avg_points)} avg pts</span>
                  </div>
                </div>

                <p style={{ margin: "8px 0 0", fontSize: "0.86rem" }}>{why.detail}</p>

                <details className="consensus-numbers">
                  <summary className="faint">Show the numbers behind this</summary>
                  <div className="consensus-meters">
                    <div>
                      <div className="spread">
                        <span className="faint">Scoring, compared to the rest of the event</span>
                        <b className="mono">{rankWord(t.quant_pct)}</b>
                      </div>
                      <Bar value={t.quant_pct} max={1} />
                    </div>
                    <div>
                      <div className="spread">
                        <span className="faint">How scouts rate it (driving, reliability, tags)</span>
                        <b className="mono">{rankWord(t.qual_pct)}</b>
                      </div>
                      <Bar value={t.qual_pct} max={1} />
                    </div>
                  </div>
                  <p className="faint" style={{ margin: "8px 0 0", fontSize: "0.76rem" }}>
                    When those two bars are far apart, the team is either flattering
                    or hiding its real ability. Biggest gap between two scouts on the
                    same match: {num(t.max_spread, 1)} points.
                  </p>
                </details>

                {t.conflicts.length > 0 && (
                  <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => setOpen(expanded ? null : t.team)}>
                    <Icon name="search" size={14} />
                    {expanded ? "Hide" : "Show"} the matches scouts disagreed on ({t.conflicts.length})
                  </button>
                )}
                {expanded && (
                  <div className="consensus-conflicts">
                    {t.conflicts.map((c) => (
                      <div key={c.match} className="consensus-conflict">
                        <span className="badge haze">Q{c.match}</span>
                        <span className="badge amber">{num(c.spread, 1)} points apart</span>
                        {c.reports.map((r, i) => (
                          <span key={i} className="badge muted">
                            {r.scout_id} said {num(r.points, 1)}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {flagged.length > 0 && flagged.length < teams.length && (
            <button className="btn ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show only teams to check" : `Show all ${teams.length} teams`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Percentiles mean nothing at a glance. Words do. */
function rankWord(p: number): string {
  if (p >= 0.8) return "Top of the event";
  if (p >= 0.6) return "Above average";
  if (p >= 0.4) return "Middle";
  if (p >= 0.2) return "Below average";
  return "Bottom of the event";
}
