"use client";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { PitRow, PitsBoard } from "@/lib/pits";

export default function PitsPage() {
  const [board, setBoard] = useState<PitsBoard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try { setBoard(await api<PitsBoard>("/api/pits")); setError(""); }
    catch { setError("Could not refresh the schedule. Check your connection and try again."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(load, 60000); return () => clearInterval(timer); }, [load]);
  return <div className="operations-page">
    <header className="operations-heading"><div><h1>Pits</h1><p>Know your shift. Be ready to queue.</p></div><button className="btn" onClick={load} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button></header>
    {error && <p role="alert">{error}</p>}
    {board?.updated_at && <p className="faint">Published {new Date(board.updated_at).toLocaleString()} · Times shown as listed in the event sheet.</p>}
    {!board && busy ? <p role="status">Loading pit rotations and matches…</p> : <>
      <section className="operations-section"><h2><span>01</span> Pit rotations</h2><p>Check in with your lead before each shift.</p><div className="operations-grid">{[418, 436].map(team => <TeamTable key={team} team={team} kind="rotations" rows={board?.rotations || []} />)}</div></section>
      <section className="operations-section"><h2><span>02</span> Match schedule</h2><p>Bring your robot, a charged battery and the full drive team. Follow official queue calls.</p><div className="operations-grid">{[418, 436].map(team => <TeamTable key={team} team={team} kind="matches" rows={board?.matches || []} />)}</div></section>
    </>}
    {board && !board.updated_at && <p className="faint">Your event schedule will appear here after an admin imports the event sheet.</p>}
  </div>;
}
function TeamTable({ team, kind, rows }: { team: number; kind: "rotations" | "matches"; rows: PitRow[] }) {
  const columns = kind === "rotations" ? [["time", "Time window"], ["lead", "Pit lead"], ["mechanical", "Mechanical"], ["electrical", "Electrical"], ["runner", "Runner"], ...(team === 436 ? [["driver", "DRIVER"]] : []), ["handoff", "Focus / handoff"]] : [["match", "Match"], ["queue", "Queue by"], ["field", "On field"], ["station", "Station"], ["partners", "Partners"]];
  const filtered = rows.filter(row => row.team === team);
  return <article className="operations-table"><h3>Team <strong>{team}</strong></h3><div className="operations-scroll" tabIndex={0} role="region" aria-label={`Team ${team} ${kind}`}><table><thead><tr>{columns.map(([key, label]) => <th key={key} scope="col">{label}</th>)}</tr></thead><tbody>{filtered.length ? filtered.map((row, i) => <tr key={i}>{columns.map(([key]) => <td key={key}>{row[key] || "—"}</td>)}</tr>) : <tr><td className="operations-empty" colSpan={columns.length}>No {kind} published yet.</td></tr>}</tbody></table></div></article>;
}
