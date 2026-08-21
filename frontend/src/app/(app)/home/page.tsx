"use client";
// The scout's landing screen.
//
// Deliberately thin. A row of tiles used to duplicate the sidebar, one link
// per destination, which made the page look busy while telling nobody
// anything they could not already see in the nav. What is left is the three
// things a scout actually opens this page to find out: which match is on,
// where they stand in the betting, and how the last few matches went.
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { onBus } from "@/lib/bus";
import { matchLabel, num, pct } from "@/lib/format";
import type { LeaderRow, MatchRec, Team, Bet } from "@/lib/types";
import { Loading, TeamAvatar, Modal } from "@/components/ui";
import { TeamDetail } from "@/components/TeamDetail";

/** How many finished matches the results strip shows. */
const RECENT_RESULTS = 5;

export default function HomePage() {
  const { session } = useAuth();
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [cur, setCur] = useState<{ current: MatchRec | null; on_deck: MatchRec[]; event: string; current_number: number } | null>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [recent, setRecent] = useState<MatchRec[]>([]);
  const [loading, setLoading] = useState(true);
  const [expand, setExpand] = useState<Team | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, c, mine, all] = await Promise.all([
        api<LeaderRow[]>("/api/betting/leaderboard"),
        api<any>("/api/matches/current"),
        api<{ bets: Bet[] }>("/api/betting/mine"),
        api<{ matches: MatchRec[] }>("/api/matches").catch(() => ({ matches: [] as MatchRec[] })),
      ]);
      setBoard(b);
      setCur(c);
      setBets(mine.bets);
      // Newest decided matches first. The schedule is already ordered, so
      // this is a filter and a reverse rather than a second request.
      setRecent(
        all.matches
          .filter((m) => m.winner != null || m.red_score != null)
          .slice(-RECENT_RESULTS)
          .reverse()
      );
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    return onBus((e) => {
      if (["bet_placed", "bets_resolved", "betting_reset", "bet_deleted", "match_advanced", "scout_submitted", "settings_changed"].includes(e)) load();
    });
  }, [load]);

  if (loading) return <Loading />;

  const openBets = bets.filter((b) => b.status === "open");
  const me = board.find((r) => r.scout_id === session?.scout_id);
  const nextMatch = cur?.current || cur?.on_deck?.[0] || null;
  const firstName = (session?.display_name || "scout").split(" ")[0];

  return (
    <div className="landing">
      <section className="hero">
        <p className="hero-kicker">
          {cur?.event ? <>Live at <b>{cur.event}</b></> : "No event set yet"}
        </p>
        <h1 className="hero-title">
          Hey {firstName}. {" "}
          {nextMatch
            ? <>let&apos;s scout <span className="haze-text">{matchLabel(nextMatch.comp_level, nextMatch.match_number)}</span></>
            : <>ready when <span className="haze-text">the schedule is</span></>}
        </h1>
        <div className="hero-cta">
          <Link href="/scout" className="btn primary lg">Scout the next match →</Link>
          {me && (
            <span className="hero-stat">
              <b className="mono">{session?.bucks ?? 0} PB</b>
              <span>rank #{me.rank}{openBets.length ? ` · ${openBets.length} open bet${openBets.length > 1 ? "s" : ""}` : ""}</span>
            </span>
          )}
        </div>
      </section>

      <div className="grid cols-2">
        {/* On the field */}
        <div className="card">
          <div className="card-h">
            <h3>On The Field</h3>
            {nextMatch && (
              <span className="badge muted">
                {cur?.current ? "Now" : "Up next"} · {matchLabel(nextMatch.comp_level, nextMatch.match_number)}
              </span>
            )}
          </div>
          {!cur?.event ? (
            <p className="muted" style={{ margin: 0 }}>No event selected yet.</p>
          ) : nextMatch ? (
            <MatchPreview m={nextMatch} onExpand={setExpand} />
          ) : (
            <p className="muted" style={{ margin: 0 }}>Schedule not published yet, check back soon.</p>
          )}
        </div>

        <div className="home-side">
          {/* Leaderboard, cut to the podium plus your own row. The full board
              is not something anyone needs on the way to a match. */}
          <div className="card tight">
            <div className="card-h"><h3>Top Bettors</h3></div>
            <ol className="mini-board">
              {board.slice(0, 3).map((r) => (
                <li key={r.scout_id} className={r.scout_id === session?.scout_id ? "me" : ""}>
                  <span className={`rank-chip sm ${["gold", "silver", "bronze"][r.rank - 1] || ""}`}>{r.rank}</span>
                  <span className="mini-board-name">{r.display_name}</span>
                  <span className="mono">{r.bucks}</span>
                  <span className="faint mono">{r.bets ? pct(r.win_rate) : "-"}</span>
                </li>
              ))}
              {me && me.rank > 3 && (
                <li className="me">
                  <span className="rank-chip sm">{me.rank}</span>
                  <span className="mini-board-name">{me.display_name}</span>
                  <span className="mono">{me.bucks}</span>
                  <span className="faint mono">{me.bets ? pct(me.win_rate) : "-"}</span>
                </li>
              )}
              {board.length === 0 && <li className="faint">No bets placed yet.</li>}
            </ol>
          </div>

          {/* Previous match scores */}
          <div className="card tight">
            <div className="card-h"><h3>Recent Results</h3></div>
            {recent.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: "0.82rem" }}>No finished matches yet.</p>
            ) : (
              <ul className="result-list">
                {recent.map((m) => (
                  <li key={m.match_key}>
                    <span className="result-match">{matchLabel(m.comp_level, m.match_number)}</span>
                    <span className={"result-score" + (m.winner === "red" ? " won" : "")}>{m.red_score ?? "-"}</span>
                    <span className="faint">-</span>
                    <span className={"result-score blue" + (m.winner === "blue" ? " won" : "")}>{m.blue_score ?? "-"}</span>
                    <span className={`badge ${m.winner === "red" ? "red" : m.winner === "blue" ? "blue" : "muted"}`}>
                      {m.winner ? m.winner : "tie"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* My open bets, only when there are any */}
      {openBets.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-h"><h3>My Open Bets</h3><Link href="/scout" className="btn sm ghost">Bet on the next match →</Link></div>
          <div className="grid auto">
            {openBets.map((b) => (
              <div key={b.id} className={`stat ${b.pick === "red" ? "alliance-red" : "alliance-blue"}`}>
                <div className="label">{matchLabel(b.comp_level, b.match_number)} · {b.pick.toUpperCase()}</div>
                <div className="value" style={{ fontSize: "1.3rem" }}>{b.wager} → {b.potential_payout} PB</div>
                <div className="faint" style={{ fontSize: "0.75rem" }}>{b.multiplier}× · {pct(b.win_prob)} win prob</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {expand && (
        <Modal onClose={() => setExpand(null)}>
          <TeamDetail team={expand} />
        </Modal>
      )}
    </div>
  );
}

function MatchPreview({ m, onExpand }: { m: MatchRec; onExpand: (t: Team) => void }) {
  return (
    <div className="grid cols-2" style={{ gap: 10 }}>
      <AllianceMini teams={m.red_teams || []} color="red" onExpand={onExpand} />
      <AllianceMini teams={m.blue_teams || []} color="blue" onExpand={onExpand} />
    </div>
  );
}

function AllianceMini({ teams, color, onExpand }: { teams: Team[]; color: "red" | "blue"; onExpand: (t: Team) => void }) {
  return (
    <div className={`card tight ${color === "red" ? "bg-red-soft alliance-red" : "bg-blue-soft alliance-blue"}`} style={{ padding: 10 }}>
      <div className="badge" style={{ marginBottom: 8, color: color === "red" ? "#fca5a5" : "#93c5fd" }}>{color.toUpperCase()}</div>
      {teams.map((t) => (
        <div key={t.team_number} className="team-chip" style={{ marginBottom: 6 }} onClick={() => onExpand(t)}>
          <TeamAvatar team={t} size="sm" />
          <div style={{ minWidth: 0 }}>
            <div className="tnum">{t.team_number}</div>
            <div className="tname" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t.nickname || "-"}
            </div>
          </div>
          {t.epa != null && <span className="badge haze" style={{ marginLeft: "auto" }}>{num(t.epa, 0)}</span>}
        </div>
      ))}
      {!teams.length && <div className="faint" style={{ fontSize: "0.8rem" }}>TBD</div>}
    </div>
  );
}
