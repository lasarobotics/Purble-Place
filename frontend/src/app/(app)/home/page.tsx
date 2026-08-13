"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { onBus } from "@/lib/bus";
import { matchLabel, num, pct } from "@/lib/format";
import type { LeaderRow, MatchRec, Team, Bet } from "@/lib/types";
import { Loading, TeamAvatar, Modal } from "@/components/ui";
import { TeamDetail } from "@/components/TeamDetail";
import { Icon } from "@/components/icons";

const ACTIONS = [
  { href: "/prematch", icon: "bot", title: "Pre-Match", sub: "Robots in the next match" },
  { href: "/film", icon: "film", title: "Film", sub: "Video + scouting, side by side" },
  { href: "/betting", icon: "coins", title: "Betting", sub: "Wager your Purple Bucks" },
  { href: "/picklists", icon: "list", title: "Picklists", sub: "Build & share pick lists" },
];

export default function HomePage() {
  const { session } = useAuth();
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [cur, setCur] = useState<{ current: MatchRec | null; on_deck: MatchRec[]; event: string; current_number: number } | null>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(true);
  const [expand, setExpand] = useState<Team | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, c, mine] = await Promise.all([
        api<LeaderRow[]>("/api/betting/leaderboard"),
        api<any>("/api/matches/current"),
        api<{ bets: Bet[] }>("/api/betting/mine"),
      ]);
      setBoard(b);
      setCur(c);
      setBets(mine.bets);
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
      {/* Hero */}
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
        <p className="hero-sub">
          {nextMatch
            ? "One page, top to bottom. Your alliance and station are already remembered."
            : "An admin sets the event in the Dashboard, then everything lights up."}
        </p>
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

      {/* Big, obvious destinations */}
      <section className="action-tiles">
        {ACTIONS.map((a) => (
          <Link key={a.href} href={a.href} className="action-tile">
            <span className="action-ico"><Icon name={a.icon} size={22} /></span>
            <b>{a.title}</b>
            <span className="action-sub">{a.sub}</span>
          </Link>
        ))}
      </section>

      <div className="grid cols-2">
        {/* On the field */}
        <div className="card">
          <div className="card-h">
            <h3>On The Field</h3>
            <Link href="/prematch" className="btn sm ghost">Pre-Match →</Link>
          </div>
          {!cur?.event ? (
            <p className="muted" style={{ margin: 0 }}>No event selected yet.</p>
          ) : nextMatch ? (
            <>
              <div className="muted" style={{ fontSize: "0.78rem", marginBottom: 8 }}>
                {cur.current ? "Now" : "Up next"} · {matchLabel(nextMatch.comp_level, nextMatch.match_number)}
              </div>
              <MatchPreview m={nextMatch} onExpand={setExpand} />
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Schedule not published yet, check back soon.</p>
          )}
        </div>

        {/* Leaderboard, trimmed */}
        <div className="card">
          <div className="card-h"><h3>Top Bettors</h3><Link href="/betting" className="btn sm ghost">Betting →</Link></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>#</th><th>Scout</th><th className="num">Bucks</th><th className="num">Win%</th></tr></thead>
              <tbody>
                {board.slice(0, 5).map((r) => (
                  <tr key={r.scout_id} style={r.scout_id === session?.scout_id ? { background: "rgba(102,51,153,0.25)" } : {}}>
                    <td><span className={r.rank <= 3 ? `rank-chip ${["gold", "silver", "bronze"][r.rank - 1]}` : "rank-chip"}>{r.rank}</span></td>
                    <td>{r.display_name}</td>
                    <td className="num mono">{r.bucks}</td>
                    <td className="num mono">{r.bets ? pct(r.win_rate) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* My open bets, only when there are any */}
      {openBets.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-h"><h3>My Open Bets</h3><Link href="/betting" className="btn sm ghost">Betting →</Link></div>
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
