"use client";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { matchLabel } from "@/lib/format";
import type { Bet, MatchRec } from "@/lib/types";
import { Loading, Stat, Stepper, TeamIdentity } from "@/components/ui";

interface AdminSettings { current_event: string; current_match: number; betting_enabled: boolean; season: number; is_azure: boolean; }
interface ScouterRow { scout_id: string; display_name: string; is_admin: boolean; bucks: number; matches_scouted: number; }
interface AdminBet extends Bet { scout_name?: string; }

export default function AdminDashboard() {
  const toast = useToast();
  const [s, setS] = useState<AdminSettings | null>(null);
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [scouters, setScouters] = useState<ScouterRow[]>([]);
  const [bets, setBets] = useState<AdminBet[]>([]);
  const [event, setEvent] = useState("");
  const [curMatch, setCurMatch] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const [set, sc] = await Promise.all([
        api<AdminSettings>("/api/admin/settings"),
        api<ScouterRow[]>("/api/admin/scouters"),
      ]);
      setS(set); setEvent(set.current_event); setCurMatch(set.current_match); setScouters(sc);
      const [m, allBets] = await Promise.all([
        api<{ matches: MatchRec[] }>("/api/matches?include_teams=true").catch(() => ({ matches: [] })),
        api<AdminBet[]>("/api/admin/bets").catch(() => []),
      ]);
      setMatches(m.matches);
      setBets(allBets);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    return onBus((e) => { if (["scout_submitted", "bet_placed", "match_advanced", "settings_changed"].includes(e)) load(); });
  }, [load]);

  async function saveEvent() {
    setBusy("event");
    try {
      const r = await api<{ matches: number; bets_settled?: number }>("/api/admin/event", { method: "POST", body: { event_key: event.trim() } });
      toast(`Event set · ${r.matches} matches loaded`, "ok");
      if (r.bets_settled) toast(`${r.bets_settled} bets settled from TBA results`, "ok");
      await load();
    } catch (e: any) { toast(e.message || "Failed", "err"); } finally { setBusy(""); }
  }
  async function saveCurrent(n: number) {
    setCurMatch(n);
    try {
      const r = await api<{ bets_settled: number }>("/api/admin/current-match", { method: "POST", body: { match_number: n } });
      if (r.bets_settled) toast(`${r.bets_settled} bets settled`, "ok");
    } catch (e: any) { toast(e.message || "Failed", "err"); }
  }
  async function resetBetting() {
    if (!confirm("Reset EVERYONE to 100 Purple Bucks and clear all bets?")) return;
    await api("/api/admin/betting/reset", { method: "POST" });
    toast("All balances reset to 100 PB", "ok");
    load();
  }
  async function toggleBetting(enabled: boolean) {
    setBusy("betting-toggle");
    try {
      const r = await api<{ betting_enabled: boolean }>("/api/admin/betting/toggle", { method: "POST", body: { enabled } });
      setS((cur) => cur ? { ...cur, betting_enabled: r.betting_enabled } : cur);
      toast(`Betting turned ${r.betting_enabled ? "on" : "off"}`, "ok");
      await load();
    } catch (e: any) { toast(e.message || "Failed", "err"); } finally { setBusy(""); }
  }
  async function deleteBet(bet: AdminBet) {
    if (!confirm(`Delete bet #${bet.id} from ${bet.scout_name || bet.scout_id}?`)) return;
    await api(`/api/admin/bets/${bet.id}`, { method: "DELETE" });
    toast("Bet deleted", "ok");
    load();
  }

  if (loading || !s) return <Loading />;

  const qm = matches.filter((m) => m.comp_level === "qm");

  return (
    <div>
      <div className="page-title"><h1>Admin Dashboard</h1>
        <span className={`badge ${s.is_azure ? "blue" : "muted"}`}>{s.is_azure ? "Azure" : "Local"} · {s.season}</span>
      </div>
      <p className="page-sub">Control the event, match flow, betting and scouts.</p>

      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Stat label="Event" value={s.current_event || "—"} />
        <Stat label="Current Match" value={s.current_match || "—"} accent />
        <Stat label="Open Bets" value={bets.filter((b) => b.status === "open").length} />
        <Stat label="Betting" value={s.betting_enabled ? "ON" : "OFF"} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Event</h3>
          <label className="field"><span>TBA Event Key</span>
            <input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="e.g. 2026txende" />
          </label>
          <button className="btn primary" onClick={saveEvent} disabled={busy === "event"}>{busy === "event" ? "Loading schedule…" : "Set event & sync schedule"}</button>
          <p className="faint" style={{ fontSize: "0.75rem", marginTop: 8 }}>Pulls the match schedule + teams from The Blue Alliance.</p>
        </div>

        <div className="card">
          <h3>Betting Recovery</h3>
          <p className="muted">Bets lock when scouting starts. Winners settle from TBA results; payouts use Statbotics odds captured when the bet was placed.</p>
          <div className="seg" style={{ marginBottom: 12 }}>
            <button
              className={s.betting_enabled ? "on" : ""}
              onClick={() => toggleBetting(true)}
              disabled={busy === "betting-toggle" || s.betting_enabled}
            >
              Turn On
            </button>
            <button
              className={!s.betting_enabled ? "on red" : ""}
              onClick={() => toggleBetting(false)}
              disabled={busy === "betting-toggle" || !s.betting_enabled}
            >
              Turn Off
            </button>
          </div>
          <button className="btn danger block" onClick={resetBetting}>Reset everyone to 100 Purple Bucks</button>
          <p className="faint" style={{ fontSize: "0.75rem", marginTop: 8 }}>Use reset only for event setup/testing mistakes. Individual bad bets can be deleted below.</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>Match Flow</h3>
          <div className="row" style={{ gap: 10 }}>
            <span className="muted">Current match on field</span>
            <Stepper value={curMatch} onChange={saveCurrent} />
          </div>
        </div>
        <p className="faint" style={{ fontSize: "0.78rem", marginTop: 0 }}>Advancing the field pointer syncs TBA results and settles finished matches. It does not manually lock bets or set winners.</p>
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
          <table className="data">
            <thead><tr><th>Match</th><th>Red</th><th>Blue</th><th>Result</th><th>Bet Status</th></tr></thead>
            <tbody>
              {qm.map((m) => (
                <tr key={m.match_key} style={m.match_number === curMatch ? { background: "rgba(102,51,153,0.22)" } : {}}>
                  <td>{m.match_number}{m.match_number === curMatch ? " · live" : ""}</td>
                  <td>
                    <div className="match-team-list">
                      {(m.red_teams?.length ? m.red_teams : m.red.map((team_number) => ({ team_number, nickname: "" }))).map((t) => (
                        <TeamIdentity key={t.team_number} team={t} showNickname={false} />
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="match-team-list">
                      {(m.blue_teams?.length ? m.blue_teams : m.blue.map((team_number) => ({ team_number, nickname: "" }))).map((t) => (
                        <TeamIdentity key={t.team_number} team={t} showNickname={false} />
                      ))}
                    </div>
                  </td>
                  <td>{m.winner ? <span className={`badge ${m.winner === "red" ? "red" : m.winner === "blue" ? "blue" : "muted"}`}>{m.winner}</span> : <span className="faint">—</span>}</td>
                  <td>
                    <span className={`badge ${m.betting_locked || m.winner ? "amber" : "green"}`}>
                      {m.winner ? "settled" : m.betting_locked ? "locked by scouting" : "open"}
                    </span>
                  </td>
                </tr>
              ))}
              {qm.length === 0 && <tr><td colSpan={5} className="faint center">No schedule. Set an event above.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>Bets</h3><span className="badge muted">{bets.length}</span></div>
        {bets.length === 0 ? (
          <p className="muted">No bets yet.</p>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: "auto" }}>
            <table className="data">
              <thead><tr><th>ID</th><th>Scout</th><th>Match</th><th>Pick</th><th className="num">Wager</th><th className="num">Payout</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {bets.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.id}</td>
                    <td>{b.scout_name || b.scout_id}</td>
                    <td>{matchLabel(b.comp_level, b.match_number)}</td>
                    <td><span className={`badge ${b.pick}`}>{b.pick.toUpperCase()}</span></td>
                    <td className="num mono">{b.wager}</td>
                    <td className="num mono">{b.status === "open" ? `→${b.potential_payout}` : b.payout}</td>
                    <td><span className={`badge ${b.status === "won" ? "green" : b.status === "lost" ? "red" : b.status === "open" ? "amber" : "muted"}`}>{b.status}</span></td>
                    <td><button className="btn sm danger" onClick={() => deleteBet(b)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>Scouts</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Scout</th><th>Role</th><th className="num">Matches</th><th className="num">Bucks</th></tr></thead>
            <tbody>
              {scouters.map((sc) => (
                <tr key={sc.scout_id}>
                  <td>{sc.display_name}</td>
                  <td>{sc.is_admin ? <span className="badge haze">admin</span> : <span className="badge muted">scout</span>}</td>
                  <td className="num mono">{sc.matches_scouted}</td>
                  <td className="num mono">{sc.bucks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
