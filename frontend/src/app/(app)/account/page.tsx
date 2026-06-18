"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { matchLabel, timeAgo } from "@/lib/format";
import type { ScoutEntry, Bet, Team } from "@/lib/types";
import { Loading, Empty, Stat, TeamIdentity } from "@/components/ui";

export default function AccountPage() {
  const { session, logout } = useAuth();
  const [entries, setEntries] = useState<ScoutEntry[]>([]);
  const [bets, setBets] = useState<Bet[]>([]);
  const [teams, setTeams] = useState<Record<number, Team>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api<ScoutEntry[]>("/api/scout/mine").catch(() => []),
      api<{ bets: Bet[] }>("/api/betting/mine").catch(() => ({ bets: [] })),
    ]).then(([e, b]) => { setEntries(e); setBets(b.bets); setLoading(false); });
  }, []);

  useEffect(() => {
    const nums = Array.from(new Set(entries.map((e) => e.team_number))).filter((n) => n && !teams[n]);
    if (!nums.length) return;
    api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: nums } })
      .then((rows) => setTeams((cur) => ({ ...cur, ...Object.fromEntries(rows.map((t) => [t.team_number, t])) })))
      .catch(() => {});
  }, [entries, teams]);

  if (loading) return <Loading />;

  const profit = bets.filter((b) => b.status !== "open").reduce((a, b) => a + (b.payout - b.wager), 0);

  return (
    <div>
      <div className="page-title"><h1>👤 Account</h1></div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row" style={{ gap: 14 }}>
            <div className="avatar lg" style={{ display: "grid", placeItems: "center", fontWeight: 800, fontSize: "1.3rem", background: "linear-gradient(135deg,var(--haze),var(--haze-deep))" }}>
              {session?.display_name?.[0]?.toUpperCase()}
            </div>
            <div>
              <h2 style={{ margin: 0 }}>{session?.display_name}</h2>
              <div className="muted">Scouter ID: {session?.scout_id}</div>
              {session?.is_admin && <span className="badge haze">Administrator</span>}
            </div>
          </div>
          <button className="btn ghost" onClick={logout}>Sign out</button>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Purple Bucks" value={session?.bucks ?? 0} accent />
        <Stat label="Matches Scouted" value={entries.length} />
        <Stat label="Total Bets" value={bets.length} />
        <Stat label="Betting Profit" value={profit} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-h"><h3>My Scouting</h3><span className="badge muted">{entries.length}</span></div>
          {entries.length === 0 ? <Empty icon="📋" title="Nothing scouted yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Match</th><th>Team</th><th className="num">Pts</th><th>When</th></tr></thead>
                <tbody>
                  {entries.slice(0, 25).map((e) => (
                    <tr key={e.id}>
                      <td>{matchLabel(e.comp_level, e.match_number)}</td>
                      <td><TeamIdentity team={teams[e.team_number] || { team_number: e.team_number, nickname: "" }} showNickname={false} /></td>
                      <td className="num mono">{e.points}</td>
                      <td className="faint">{e.created_at ? timeAgo(e.created_at) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-h"><h3>My Bets</h3><span className="badge muted">{bets.length}</span></div>
          {bets.length === 0 ? <Empty icon="🎲" title="No bets placed" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Match</th><th>Pick</th><th className="num">Wager</th><th>Result</th></tr></thead>
                <tbody>
                  {bets.slice(0, 25).map((b) => (
                    <tr key={b.id}>
                      <td>{matchLabel(b.comp_level, b.match_number)}</td>
                      <td><span className={`badge ${b.pick}`}>{b.pick.toUpperCase()}</span></td>
                      <td className="num mono">{b.wager}</td>
                      <td><span className={`badge ${b.status === "won" ? "green" : b.status === "lost" ? "red" : "muted"}`}>{b.status === "open" ? "pending" : b.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
