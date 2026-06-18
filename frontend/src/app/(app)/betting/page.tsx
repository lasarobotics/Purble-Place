"use client";
import { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { matchLabel, pct } from "@/lib/format";
import type { MatchRec, Odds, Bet } from "@/lib/types";
import { Loading, Empty, Stat, TeamIdentity } from "@/components/ui";

export default function BettingPage() {
  const { session, setBucks, refresh } = useAuth();
  const toast = useToast();
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [sel, setSel] = useState<MatchRec | null>(null);
  const [odds, setOdds] = useState<Odds | null>(null);
  const [pick, setPick] = useState<"red" | "blue">("red");
  const [wager, setWager] = useState(10);
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(true);

  const loadBets = useCallback(async () => {
    const r = await api<{ bucks: number; bets: Bet[] }>("/api/betting/mine");
    setBets(r.bets);
    setBucks(r.bucks);
  }, [setBucks]);

  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ matches: MatchRec[] }>("/api/matches");
        // Default to first match that isn't decided.
        const open = r.matches.filter((m) => m.winner == null);
        setMatches(r.matches);
        setSel(open[0] || r.matches[0] || null);
        await loadBets();
      } catch {}
      setLoading(false);
    })();
    return onBus((e) => {
      if (["bets_resolved", "betting_reset", "bet_deleted", "match_advanced", "betting_toggled", "scout_submitted"].includes(e)) {
        loadBets();
        if (sel) loadOdds(sel);
      }
    });
  }, []);

  const loadOdds = useCallback(async (m: MatchRec) => {
    try {
      const o = await api<Odds>(`/api/betting/odds?match_key=${m.match_key}`);
      setOdds(o);
      setEnabled(o.betting_enabled);
    } catch {
      setOdds(null);
    }
  }, []);

  useEffect(() => { if (sel) loadOdds(sel); }, [sel?.match_key, loadOdds]);

  const chosen = odds ? (pick === "red" ? odds.red_odds : odds.blue_odds) : null;
  const potential = useMemo(() => (chosen ? Math.round(wager * chosen.multiplier) : 0), [wager, chosen]);

  async function place() {
    if (!sel || !odds) return;
    if (wager <= 0) return toast("Enter a wager", "err");
    if (wager > (session?.bucks ?? 0)) return toast("Not enough Purple Bucks", "err");
    setBusy(true);
    try {
      const res = await api<{ bucks: number }>("/api/betting/place", { method: "POST", body: { match_key: sel.match_key, pick, wager } });
      setBucks(res.bucks);
      toast(`Bet placed! ${wager} → ${potential} PB if ${pick.toUpperCase()} wins`, "ok");
      await loadBets();
      await loadOdds(sel);
    } catch (e: any) {
      toast(e.message || "Bet failed", "err");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;

  const open = bets.filter((b) => b.status === "open");
  const settled = bets.filter((b) => b.status !== "open");
  const upcoming = matches.filter((m) => m.winner == null);

  return (
    <div>
      <div className="page-title"><h1>🎲 Purple Bucks Betting</h1>
        <span className="badge haze">🟣 {session?.bucks} PB</span>
      </div>
      <p className="page-sub">Odds come from Statbotics win predictions. Favourites pay little; underdogs pay big. Locks when the match starts.</p>

      {!enabled && <div className="card" style={{ marginBottom: 16, borderColor: "rgba(245,158,11,0.5)" }}>⚠️ Betting is currently turned off by an admin.</div>}

      <div className="grid cols-2">
        <div className="card">
          <div className="card-h"><h3>Place a Bet</h3>
            <select value={sel?.match_key || ""} onChange={(e) => setSel(matches.find((m) => m.match_key === e.target.value) || null)} style={{ width: "auto", maxWidth: 220 }}>
              {upcoming.map((m) => <option key={m.match_key} value={m.match_key}>{matchLabel(m.comp_level, m.match_number)}</option>)}
            </select>
          </div>

          {!sel || !odds ? (
            <Empty icon="🗓️" title="No open match" sub="Pick a match to see odds." />
          ) : (
            <>
              <div className="grid cols-2" style={{ marginBottom: 14 }}>
                <button className={`card tight alliance-red ${pick === "red" ? "bg-red-soft" : ""}`} style={{ textAlign: "left", cursor: "pointer", borderColor: pick === "red" ? "var(--red)" : "var(--border)" }} onClick={() => setPick("red")}>
                  <div className="badge red">RED</div>
                  <div className="alliance-team-list">
                    {(odds.red_teams?.length ? odds.red_teams : odds.red.map((team_number) => ({ team_number, nickname: "" }))).map((t) => (
                      <TeamIdentity key={t.team_number} team={t} showNickname={false} />
                    ))}
                  </div>
                  <div style={{ fontSize: "1.5rem", fontWeight: 800, marginTop: 8 }}>{odds.red_odds.multiplier}×</div>
                  <div className="faint" style={{ fontSize: "0.78rem" }}>{pct(odds.red_odds.win_prob)} win · +{odds.red_odds.profit_pct}%</div>
                </button>
                <button className={`card tight alliance-blue ${pick === "blue" ? "bg-blue-soft" : ""}`} style={{ textAlign: "left", cursor: "pointer", borderColor: pick === "blue" ? "var(--blue)" : "var(--border)" }} onClick={() => setPick("blue")}>
                  <div className="badge blue">BLUE</div>
                  <div className="alliance-team-list">
                    {(odds.blue_teams?.length ? odds.blue_teams : odds.blue.map((team_number) => ({ team_number, nickname: "" }))).map((t) => (
                      <TeamIdentity key={t.team_number} team={t} showNickname={false} />
                    ))}
                  </div>
                  <div style={{ fontSize: "1.5rem", fontWeight: 800, marginTop: 8 }}>{odds.blue_odds.multiplier}×</div>
                  <div className="faint" style={{ fontSize: "0.78rem" }}>{pct(odds.blue_odds.win_prob)} win · +{odds.blue_odds.profit_pct}%</div>
                </button>
              </div>

              {odds.locked ? (
                <div className="card tight center" style={{ borderColor: "rgba(245,158,11,0.5)" }}>🔒 Betting closed for this match</div>
              ) : (
                <>
                  <label className="field">
                    <span>Wager (Purple Bucks)</span>
                    <input type="number" value={wager} min={1} max={session?.bucks} onChange={(e) => setWager(parseInt(e.target.value || "0", 10))} />
                  </label>
                  <div className="row" style={{ gap: 8, marginBottom: 14 }}>
                    {[5, 10, 25, 50].map((a) => <button key={a} className="chip" onClick={() => setWager(a)}>{a}</button>)}
                    <button className="chip" onClick={() => setWager(session?.bucks ?? 0)}>All in</button>
                  </div>
                  <div className="stat" style={{ marginBottom: 14 }}>
                    <div className="label">Potential payout if {pick.toUpperCase()} wins</div>
                    <div className="value haze">{potential} PB <span className="faint" style={{ fontSize: "0.9rem", fontWeight: 400 }}>(+{potential - wager})</span></div>
                  </div>
                  <button className={`btn block ${pick}`} disabled={busy || !enabled} onClick={place}>
                    {busy ? "Placing…" : `Bet ${wager} PB on ${pick.toUpperCase()}`}
                  </button>
                  <p className="faint" style={{ fontSize: "0.72rem", marginTop: 8 }}>Source: {odds.source === "statbotics" ? "Statbotics prediction" : "EPA estimate"}</p>
                </>
              )}
            </>
          )}
        </div>

        <div>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <Stat label="Open" value={open.length} />
            <Stat label="Won" value={settled.filter((b) => b.status === "won").length} />
            <Stat label="Profit" value={settled.reduce((a, b) => a + (b.payout - b.wager), 0)} accent />
          </div>
          <div className="card">
            <div className="card-h"><h3>My Bets</h3></div>
            {bets.length === 0 ? <Empty icon="🎲" title="No bets yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Match</th><th>Pick</th><th className="num">Wager</th><th className="num">Payout</th><th>Status</th></tr></thead>
                  <tbody>
                    {bets.map((b) => (
                      <tr key={b.id}>
                        <td>{matchLabel(b.comp_level, b.match_number)}</td>
                        <td><span className={`badge ${b.pick}`}>{b.pick.toUpperCase()}</span></td>
                        <td className="num mono">{b.wager}</td>
                        <td className="num mono">{b.status === "open" ? `→${b.potential_payout}` : b.payout}</td>
                        <td>
                          <span className={`badge ${b.status === "won" ? "green" : b.status === "lost" ? "red" : b.status === "refunded" ? "muted" : "amber"}`}>{b.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
