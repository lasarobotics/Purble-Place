"use client";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { matchLabel } from "@/lib/format";
import type { MatchRec } from "@/lib/types";
import { Loading, Stat, Stepper } from "@/components/ui";

interface AdminSettings { current_event: string; current_match: number; betting_enabled: boolean; season: number; is_azure: boolean; }
interface ScouterRow { scout_id: string; display_name: string; is_admin: boolean; bucks: number; matches_scouted: number; }

export default function AdminDashboard() {
  const toast = useToast();
  const [s, setS] = useState<AdminSettings | null>(null);
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [scouters, setScouters] = useState<ScouterRow[]>([]);
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
      const m = await api<{ matches: MatchRec[] }>("/api/matches").catch(() => ({ matches: [] }));
      setMatches(m.matches);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    return onBus((e) => { if (["scout_submitted", "bet_placed", "match_advanced"].includes(e)) load(); });
  }, [load]);

  async function saveEvent() {
    setBusy("event");
    try {
      const r = await api<{ matches: number }>("/api/admin/event", { method: "POST", body: { event_key: event.trim() } });
      toast(`Event set · ${r.matches} matches loaded`, "ok");
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
  async function toggleBetting(enabled: boolean) {
    await api("/api/admin/betting/toggle", { method: "POST", body: { enabled } });
    setS((x) => x ? { ...x, betting_enabled: enabled } : x);
    toast(`Betting ${enabled ? "enabled" : "disabled"}`, "ok");
  }
  async function resetBetting() {
    if (!confirm("Reset EVERYONE to 100 Purple Bucks and clear all bets?")) return;
    await api("/api/admin/betting/reset", { method: "POST" });
    toast("All balances reset to 100 PB", "ok");
    load();
  }
  async function setResult(m: MatchRec, winner: string) {
    await api("/api/admin/match/result", { method: "POST", body: { match_key: m.match_key, winner } });
    toast(`${matchLabel(m.comp_level, m.match_number)} → ${winner} · bets settled`, "ok");
    load();
  }
  async function toggleLock(m: MatchRec) {
    await api("/api/admin/match/lock", { method: "POST", body: { match_key: m.match_key, locked: !m.betting_locked } });
    setMatches((ms) => ms.map((x) => x.match_key === m.match_key ? { ...x, betting_locked: !x.betting_locked } : x));
  }

  if (loading || !s) return <Loading />;

  const qm = matches.filter((m) => m.comp_level === "qm");

  return (
    <div>
      <div className="page-title"><h1>⚙️ Admin Dashboard</h1>
        <span className={`badge ${s.is_azure ? "blue" : "muted"}`}>{s.is_azure ? "Azure" : "Local"} · {s.season}</span>
      </div>
      <p className="page-sub">Control the event, match flow, betting and scouts.</p>

      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Stat label="Event" value={s.current_event || "—"} />
        <Stat label="Current Match" value={s.current_match || "—"} accent />
        <Stat label="Betting" value={s.betting_enabled ? "ON" : "OFF"} />
        <Stat label="Scouts" value={scouters.length} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>🗓️ Event</h3>
          <label className="field"><span>TBA Event Key</span>
            <input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="e.g. 2026txende" />
          </label>
          <button className="btn primary" onClick={saveEvent} disabled={busy === "event"}>{busy === "event" ? "Loading schedule…" : "Set event & sync schedule"}</button>
          <p className="faint" style={{ fontSize: "0.75rem", marginTop: 8 }}>Pulls the match schedule + teams from The Blue Alliance.</p>
        </div>

        <div className="card">
          <h3>🎲 Betting Control</h3>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
            <span className="muted">Betting is currently <b>{s.betting_enabled ? "ON" : "OFF"}</b></span>
            <div className="seg">
              <button className={s.betting_enabled ? "on" : ""} onClick={() => toggleBetting(true)}>On</button>
              <button className={!s.betting_enabled ? "on" : ""} onClick={() => toggleBetting(false)}>Off</button>
            </div>
          </div>
          <button className="btn danger block" onClick={resetBetting}>♻️ Reset everyone to 100 Purple Bucks</button>
          <p className="faint" style={{ fontSize: "0.75rem", marginTop: 8 }}>Clears all bets and resets every balance to the starting 100 PB.</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>🏁 Match Flow</h3>
          <div className="row" style={{ gap: 10 }}>
            <span className="muted">Current match on field</span>
            <Stepper value={curMatch} onChange={saveCurrent} />
          </div>
        </div>
        <p className="faint" style={{ fontSize: "0.78rem", marginTop: 0 }}>Advancing the current match locks betting on it and settles finished matches automatically.</p>
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
          <table className="data">
            <thead><tr><th>Match</th><th>Red</th><th>Blue</th><th>Result</th><th>Bets</th><th>Set winner</th></tr></thead>
            <tbody>
              {qm.map((m) => (
                <tr key={m.match_key} style={m.match_number === curMatch ? { background: "rgba(102,51,153,0.22)" } : {}}>
                  <td>{m.match_number}{m.match_number === curMatch ? " 🔴" : ""}</td>
                  <td className="mono" style={{ color: "#fca5a5" }}>{m.red.join(" ")}</td>
                  <td className="mono" style={{ color: "#93c5fd" }}>{m.blue.join(" ")}</td>
                  <td>{m.winner ? <span className={`badge ${m.winner === "red" ? "red" : m.winner === "blue" ? "blue" : "muted"}`}>{m.winner}</span> : <span className="faint">—</span>}</td>
                  <td><button className="btn sm ghost" onClick={() => toggleLock(m)}>{m.betting_locked ? "🔒" : "🔓"}</button></td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn sm red" onClick={() => setResult(m, "red")}>R</button>
                      <button className="btn sm blue" onClick={() => setResult(m, "blue")}>B</button>
                      <button className="btn sm ghost" onClick={() => setResult(m, "tie")}>T</button>
                    </div>
                  </td>
                </tr>
              ))}
              {qm.length === 0 && <tr><td colSpan={6} className="faint center">No schedule. Set an event above.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>👥 Scouts</h3></div>
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
