"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { onBus } from "@/lib/bus";
import { matchLabel, num, pct } from "@/lib/format";
import type { LeaderRow, MatchRec, Team, Bet } from "@/lib/types";
import { Loading, Stat, TeamAvatar, Modal } from "@/components/ui";
import { TeamDetail } from "@/components/TeamDetail";

export default function HomePage() {
  const { session } = useAuth();
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [cur, setCur] = useState<{ current: MatchRec | null; on_deck: MatchRec[]; event: string } | null>(null);
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
      if (["bet_placed", "bets_resolved", "betting_reset", "bet_deleted", "match_advanced", "scout_submitted"].includes(e)) load();
    });
  }, [load]);

  if (loading) return <Loading />;

  const openBets = bets.filter((b) => b.status === "open");
  const settled = bets.filter((b) => b.status !== "open");
  const won = settled.filter((b) => b.status === "won").length;
  const me = board.find((r) => r.scout_id === session?.scout_id);

  return (
    <div>
      <div className="page-title">
        <h1>Welcome back, <span className="haze-text">{session?.display_name}</span> 🟣</h1>
      </div>
      <p className="page-sub">Your hub for live scouting, betting and strategy.</p>

      <div className="grid cols-4" style={{ marginBottom: 20 }}>
        <Stat label="Purple Bucks" value={session?.bucks ?? 0} accent />
        <Stat label="Leaderboard Rank" value={me ? `#${me.rank}` : "—"} />
        <Stat label="Open Bets" value={openBets.length} />
        <Stat label="Bets Won" value={won} />
      </div>

      <div className="grid cols-2">
        {/* Leaderboard */}
        <div className="card">
          <div className="card-h"><h3>🏆 Top Bettors</h3><span className="badge muted">{board.length} scouts</span></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>#</th><th>Scout</th><th className="num">Bucks</th><th className="num">Win%</th></tr></thead>
              <tbody>
                {board.slice(0, 10).map((r) => (
                  <tr key={r.scout_id} style={r.scout_id === session?.scout_id ? { background: "rgba(102,51,153,0.25)" } : {}}>
                    <td><span className={r.rank <= 3 ? `rank-chip ${["gold", "silver", "bronze"][r.rank - 1]}` : "rank-chip"}>{r.rank}</span></td>
                    <td>{r.display_name}{r.is_admin && <span className="badge haze" style={{ marginLeft: 6 }}>admin</span>}</td>
                    <td className="num mono">{r.bucks}</td>
                    <td className="num mono">{r.bets ? pct(r.win_rate) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* On deck */}
        <div className="card">
          <div className="card-h">
            <h3>🤖 On The Field</h3>
            <Link href="/prematch" className="btn sm ghost">Pre-Match →</Link>
          </div>
          {!cur?.event ? (
            <p className="muted">No event selected yet. An admin sets the current event in the Dashboard.</p>
          ) : cur?.current ? (
            <MatchPreview m={cur.current} onExpand={setExpand} />
          ) : (
            <p className="muted">Waiting for the first match. Up next:</p>
          )}
          {cur?.on_deck?.slice(0, 2).map((m) => (
            <div key={m.match_key} style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: "0.78rem", marginBottom: 6 }}>Next · {matchLabel(m.comp_level, m.match_number)}</div>
              <MatchPreview m={m} onExpand={setExpand} compact />
            </div>
          ))}
        </div>
      </div>

      {/* My open bets */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-h"><h3>🎲 My Open Bets</h3><Link href="/betting" className="btn sm ghost">Betting →</Link></div>
        {openBets.length === 0 ? (
          <p className="muted">No open bets. Head to the Betting tab to wager on upcoming matches.</p>
        ) : (
          <div className="grid auto">
            {openBets.map((b) => (
              <div key={b.id} className={`stat ${b.pick === "red" ? "alliance-red" : "alliance-blue"}`}>
                <div className="label">{matchLabel(b.comp_level, b.match_number)} · {b.pick.toUpperCase()}</div>
                <div className="value" style={{ fontSize: "1.3rem" }}>{b.wager} → {b.potential_payout} PB</div>
                <div className="faint" style={{ fontSize: "0.75rem" }}>{b.multiplier}× · {pct(b.win_prob)} win prob</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {expand && (
        <Modal onClose={() => setExpand(null)}>
          <TeamDetail team={expand} />
        </Modal>
      )}
    </div>
  );
}

function MatchPreview({ m, onExpand, compact }: { m: MatchRec; onExpand: (t: Team) => void; compact?: boolean }) {
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
              {t.nickname || "—"}
            </div>
          </div>
          {t.epa != null && <span className="badge haze" style={{ marginLeft: "auto" }}>{num(t.epa, 0)}</span>}
        </div>
      ))}
      {!teams.length && <div className="faint" style={{ fontSize: "0.8rem" }}>TBD</div>}
    </div>
  );
}
