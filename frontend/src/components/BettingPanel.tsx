"use client";
// Purple Bucks betting, as a panel rather than a page.
//
// Betting used to be its own tab, which meant leaving the scouting form to
// place a bet on a match you were about to watch anyway. It now sits beside
// the scouting form, so it is compact by design: the match picker, the two
// alliances with their odds, a wager, and a short ledger. Everything that
// needed a full screen (the stat tiles, the full bet history table) is folded
// into a collapsible list.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { matchLabel, pct } from "@/lib/format";
import type { Bet, MatchRec, Odds } from "@/lib/types";
import { Empty, TeamIdentity } from "@/components/ui";

const QUICK_WAGERS = [5, 10, 25, 50];

export function BettingPanel({ matchNumber }: { matchNumber?: number }) {
  const { session, setBucks } = useAuth();
  const toast = useToast();
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [sel, setSel] = useState<MatchRec | null>(null);
  const [odds, setOdds] = useState<Odds | null>(null);
  const [pick, setPick] = useState<"red" | "blue">("red");
  const [wager, setWager] = useState(10);
  const [bets, setBets] = useState<Bet[]>([]);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [showLedger, setShowLedger] = useState(false);

  const loadBets = useCallback(async () => {
    try {
      const r = await api<{ bucks: number; bets: Bet[] }>("/api/betting/mine");
      setBets(r.bets);
      setBucks(r.bucks);
    } catch {}
  }, [setBucks]);

  const loadOdds = useCallback(async (m: MatchRec) => {
    try {
      const o = await api<Odds>(`/api/betting/odds?match_key=${m.match_key}`);
      setOdds(o);
      setEnabled(o.betting_enabled);
    } catch {
      setOdds(null);
    }
  }, []);

  const loadMatches = useCallback(async () => {
    try {
      const r = await api<{ matches: MatchRec[] }>("/api/matches");
      setMatches(r.matches);
      setSel((cur) => {
        if (cur) return r.matches.find((m) => m.match_key === cur.match_key) || cur;
        const open = r.matches.filter((m) => m.winner == null);
        // Default to the match being scouted, which is almost always the one
        // the person at this screen wants to bet on.
        return (
          open.find((m) => m.comp_level === "qm" && m.match_number === matchNumber) ||
          open[0] ||
          r.matches[0] ||
          null
        );
      });
    } catch {}
  }, [matchNumber]);

  useEffect(() => {
    loadMatches();
    loadBets();
    return onBus((e) => {
      if (["bets_resolved", "betting_reset", "bet_deleted", "match_advanced",
           "betting_toggled", "scout_submitted"].includes(e)) {
        loadMatches();
        loadBets();
      }
    });
  }, [loadMatches, loadBets]);

  useEffect(() => { if (sel) loadOdds(sel); }, [sel?.match_key, loadOdds]);

  const chosen = odds ? (pick === "red" ? odds.red_odds : odds.blue_odds) : null;
  const potential = useMemo(() => (chosen ? Math.round(wager * chosen.multiplier) : 0), [wager, chosen]);
  const open = bets.filter((b) => b.status === "open");
  const settled = bets.filter((b) => b.status !== "open");
  const profit = settled.reduce((a, b) => a + (b.payout - b.wager), 0);
  const upcoming = matches.filter((m) => m.winner == null);

  async function place() {
    if (!sel || !odds) return;
    if (wager <= 0) return toast("Enter a wager", "err");
    if (wager > (session?.bucks ?? 0)) return toast("Not enough Purple Bucks", "err");
    setBusy(true);
    try {
      const res = await api<{ bucks: number }>("/api/betting/place", {
        method: "POST",
        body: { match_key: sel.match_key, pick, wager },
      });
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

  return (
    <section className="card bet-panel">
      <div className="card-h">
        <h3 style={{ margin: 0 }}>Prediction</h3>
        <span className="badge haze">{session?.bucks ?? 0} PB</span>
      </div>

      {!enabled && (
        <p className="faint" style={{ margin: "0 0 10px", fontSize: "0.8rem" }}>
          Betting disabled
        </p>
      )}

      <select
        className="bet-match-select"
        value={sel?.match_key || ""}
        onChange={(e) => setSel(matches.find((m) => m.match_key === e.target.value) || null)}
      >
        {upcoming.length === 0 && <option value="">No open matches</option>}
        {upcoming.map((m) => (
          <option key={m.match_key} value={m.match_key}>
            {matchLabel(m.comp_level, m.match_number)}
          </option>
        ))}
      </select>

      {!sel || !odds ? (
        <Empty icon="dice" title="No open match" sub="Odds appear once a schedule is loaded." />
      ) : (
        <>
          <div className="bet-sides">
            {(["red", "blue"] as const).map((side) => {
              const o = side === "red" ? odds.red_odds : odds.blue_odds;
              const roster = side === "red"
                ? (odds.red_teams?.length ? odds.red_teams : odds.red.map((team_number) => ({ team_number, nickname: "" })))
                : (odds.blue_teams?.length ? odds.blue_teams : odds.blue.map((team_number) => ({ team_number, nickname: "" })));
              return (
                <button
                  key={side}
                  type="button"
                  className={`bet-side ${side}` + (pick === side ? " on" : "")}
                  aria-pressed={pick === side}
                  onClick={() => setPick(side)}
                >
                  <span className="bet-side-head">
                    <span className={`badge ${side}`}>{side.toUpperCase()}</span>
                    <b className="mono">{o.multiplier}×</b>
                  </span>
                  <span className="bet-side-teams">
                    {roster.map((t) => (
                      <TeamIdentity key={t.team_number} team={t} showNickname={false} />
                    ))}
                  </span>
                  <span className="faint bet-side-prob">{pct(o.win_prob)} win</span>
                </button>
              );
            })}
          </div>

          {odds.locked ? (
            <p className="bet-locked">{odds.lock_reason || "Betting is closed for this match."}</p>
          ) : (
            <>
              <div className="bet-wager">
                <input
                  type="number"
                  value={wager}
                  min={1}
                  max={session?.bucks}
                  onChange={(e) => setWager(parseInt(e.target.value || "0", 10))}
                  aria-label="Wager in Purple Bucks"
                />
                {QUICK_WAGERS.map((a) => (
                  <button key={a} type="button" className="chip" onClick={() => setWager(a)}>{a}</button>
                ))}
                <button type="button" className="chip" onClick={() => setWager(session?.bucks ?? 0)}>All in</button>
              </div>
              <button className={`btn block ${pick}`} disabled={busy || !enabled} onClick={place}>
                {busy ? "Placing..." : `Bet ${wager} PB on ${pick.toUpperCase()} → ${potential} PB`}
              </button>
            </>
          )}
        </>
      )}

      <div className="bet-ledger-head">
        <span className="faint">
          {open.length} open · {settled.filter((b) => b.status === "won").length} won ·{" "}
          <b className={profit >= 0 ? "pos" : "neg"}>{profit >= 0 ? "+" : ""}{profit} PB</b>
        </span>
        {bets.length > 0 && (
          <button type="button" className="btn sm ghost" onClick={() => setShowLedger((v) => !v)}>
            {showLedger ? "Hide bets" : "My bets"}
          </button>
        )}
      </div>

      {showLedger && bets.length > 0 && (
        <div className="table-wrap bet-ledger">
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
                    <span className={`badge ${b.status === "won" ? "green" : b.status === "lost" ? "red" : b.status === "refunded" ? "muted" : "amber"}`}>
                      {b.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
