"use client";
import { PitsSettings } from "@/components/PitsSettings";
import { DeletePicklists } from "@/components/DeletePicklists";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { matchLabel } from "@/lib/format";
import type { Bet, MatchRec, Role } from "@/lib/types";
import { ROLE_LABEL } from "@/lib/types";
import { Loading, Modal, Stat, Stepper, TeamIdentity } from "@/components/ui";

// environment: "cloud-run" | "firebase" | "emulator" | "local"
interface AdminSettings {
  current_event: string;
  current_match: number;
  betting_enabled: boolean;
  post_comp_mode: boolean;
  season: number;
  environment: string;
  tba_configured: boolean;
}

const ENV_LABEL: Record<string, string> = {
  "cloud-run": "Firebase",
  firebase: "Firebase",
  emulator: "Emulator",
  local: "Local",
};
interface ScouterRow { scout_id: string; display_name: string; role: string; is_admin: boolean; bucks: number; matches_scouted: number; }
interface AdminBet extends Bet { scout_name?: string; }
interface ArchiveSummary {
  event_key: string;
  name: string;
  archived_at: string;
  counts: Record<string, number>;
  match_count?: number;
  team_count?: number;
  scouting_count?: number;
}
interface ArchiveDetail extends ArchiveSummary {
  teams: Record<string, any>;
  matches: any[];
  scouting: any[];
  pit_raw: any[];
  picklists_raw: any[];
  bets: any[];
  analytics: Record<string, any>;
}

export default function AdminDashboard() {
  const toast = useToast();
  const [s, setS] = useState<AdminSettings | null>(null);
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [scouters, setScouters] = useState<ScouterRow[]>([]);
  const [bets, setBets] = useState<AdminBet[]>([]);
  const [archives, setArchives] = useState<ArchiveSummary[]>([]);
  const [openArchive, setOpenArchive] = useState<ArchiveDetail | null>(null);
  const [event, setEvent] = useState("");
  const [curMatch, setCurMatch] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [passwordResetOpen, setPasswordResetOpen] = useState(false);
  const [passwordResetId, setPasswordResetId] = useState("");
  const [passwordResetError, setPasswordResetError] = useState("");
  const [scheduleImportOpen, setScheduleImportOpen] = useState(false);
  const [scheduleFile, setScheduleFile] = useState<File | null>(null);

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
      setArchives(await api<ArchiveSummary[]>("/api/admin/archives").catch(() => []));
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
      if (r.matches === 0) {
        toast(s?.tba_configured
          ? "Event set, but TBA returned no schedule. Check the event key or import a CSV."
          : "Event set. No TBA key is configured, so import the schedule CSV below.", "err");
      } else {
        toast(`Event set · ${r.matches} matches loaded`, "ok");
      }
      if (r.bets_settled) toast(`${r.bets_settled} bets settled from TBA results`, "ok");
      await load();
    } catch (e: any) { toast(e.message || "Failed", "err"); } finally { setBusy(""); }
  }
  async function importSchedule(file: File) {
    if (!event.trim()) return toast("Set the event key before importing a schedule", "err");
    if (!file.name.toLowerCase().endsWith(".csv")) return toast("Choose a .csv schedule file", "err");
    setBusy("schedule-csv");
    try {
      const result = await api<{ matches: number }>("/api/admin/schedule/csv", {
        method: "POST", body: { event_key: event.trim(), csv_text: await file.text() },
      });
      toast(`Imported ${result.matches} matches`, "ok");
      setScheduleImportOpen(false); setScheduleFile(null);
      await load();
    } catch (e: any) { toast(e.message || "Could not import the schedule", "err"); }
    finally { setBusy(""); }
  }
  async function archiveAndReset() {
    if (!s.current_event) return toast("Set an event before archiving", "err");
    const fallback = s.current_event;
    const name = prompt("Archive name", fallback);
    if (name === null) return;
    if (!confirm(`Archive ${fallback} and clear active competition data? This cannot be undone.`)) return;
    setBusy("archive-reset");
    try {
      const r = await api<{ archive: ArchiveDetail; deleted: Record<string, number> }>("/api/admin/archive-and-reset", {
        method: "POST",
        body: { name: name.trim() || fallback },
      });
      toast(`Archived ${r.archive.name}. Active event cleared.`, "ok");
      setOpenArchive(r.archive);
      await load();
    } catch (e: any) {
      toast(e.message || "Archive failed; active data was not cleared", "err");
    } finally {
      setBusy("");
    }
  }
  async function openArchiveDetail(eventKey: string) {
    setBusy(`archive-${eventKey}`);
    try {
      setOpenArchive(await api<ArchiveDetail>(`/api/admin/archives/${eventKey}`));
    } catch (e: any) {
      toast(e.message || "Could not open archive", "err");
    } finally {
      setBusy("");
    }
  }
  async function saveCurrent(n: number) {
    if (n < 1) return toast("Current match must be at least 1", "err");
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
  async function togglePostComp(enabled: boolean) {
    const msg = enabled
      ? "Turn on Post-Comp Mode? Visitors will see a 404 until the unlock code is entered."
      : "Turn off Post-Comp Mode and make the site public again?";
    if (!confirm(msg)) return;
    setBusy("post-comp-toggle");
    try {
      const r = await api<{ post_comp_mode: boolean }>("/api/admin/post-comp/toggle", { method: "POST", body: { enabled } });
      setS((cur) => cur ? { ...cur, post_comp_mode: r.post_comp_mode } : cur);
      toast(`Post-Comp Mode ${r.post_comp_mode ? "enabled" : "disabled"}`, "ok");
      await load();
    } catch (e: any) { toast(e.message || "Failed", "err"); } finally { setBusy(""); }
  }
  async function deleteBet(bet: AdminBet) {
    if (!confirm(`Delete bet #${bet.id} from ${bet.scout_name || bet.scout_id}?`)) return;
    await api(`/api/admin/bets/${bet.id}`, { method: "DELETE" });
    toast("Bet deleted", "ok");
    load();
  }

  async function resetUserPassword(e: React.FormEvent) {
    e.preventDefault();
    const scoutId = passwordResetId.trim();
    if (!scoutId) {
      setPasswordResetError("Enter a user ID.");
      return;
    }
    setBusy("password-reset");
    setPasswordResetError("");
    try {
      const result = await api<{ scout_id: string }>("/api/admin/scouters/password-reset", {
        method: "POST",
        body: { scout_id: scoutId },
      });
      setPasswordResetOpen(false);
      setPasswordResetId("");
      toast(`Password reset for ${result.scout_id}. They will create a new password next time they sign in.`, "ok");
    } catch (e: any) {
      setPasswordResetError(e.message || "Could not reset password");
    } finally {
      setBusy("");
    }
  }

  if (loading || !s) return <Loading />;

  const qm = matches.filter((m) => m.comp_level === "qm");

  return (
    <div>
      <div className="page-title"><h1>Admin Dashboard</h1><DeletePicklists />
        <span className={`badge ${s.environment === "cloud-run" || s.environment === "firebase" ? "blue" : "muted"}`}>
          {ENV_LABEL[s.environment] || s.environment} · {s.season}
        </span>
      </div>


      <PitsSettings />
      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Stat label="Event" value={s.current_event || "-"} />
        <Stat label="Current Match" value={s.current_match || "-"} accent />
        <Stat label="Accounts" value={scouters.length} />
        <Stat label="Matches Scouted" value={scouters.reduce((a, sc) => a + sc.matches_scouted, 0)} />
      </div>

        <div className="card">
          <h3>Event</h3>
          <label className="field"><span>TBA Event Key</span>
            <input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="e.g. 2026txende" />
          </label>
          <button className="btn primary" onClick={saveEvent} disabled={busy === "event"}>{busy === "event" ? "Loading schedule..." : "Set event & sync schedule"}</button>
          {!s.tba_configured && <p className="muted">No TBA key is configured. Import the event schedule from a CSV file.</p>}
          <button className="btn" style={{ marginLeft: 8 }} onClick={() => { setScheduleFile(null); setScheduleImportOpen(true); }}>Import match schedule CSV</button>
          <button className="btn danger" style={{ marginLeft: 8 }} onClick={archiveAndReset} disabled={busy === "archive-reset" || !s.current_event}>
            {busy === "archive-reset" ? "Archiving..." : "Archive Competition & Start Fresh"}
          </button>

        </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>Site Access</h3><span className={`badge ${s.post_comp_mode ? "amber" : "green"}`}>{s.post_comp_mode ? "Post-comp" : "Open"}</span></div>
        <p className="muted" style={{ marginTop: 0 }}>
          Post-Comp Mode shows visitors a 404 and keeps the app from making API calls until the unlock code is entered.
        </p>
        <div className="seg">
          <button
            className={!s.post_comp_mode ? "on" : ""}
            onClick={() => togglePostComp(false)}
            disabled={busy === "post-comp-toggle" || !s.post_comp_mode}
          >
            Open
          </button>
          <button
            className={s.post_comp_mode ? "on red" : ""}
            onClick={() => togglePostComp(true)}
            disabled={busy === "post-comp-toggle" || s.post_comp_mode}
          >
            Post-Comp Mode
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>Archived Competitions</h3><span className="badge muted">{archives.length}</span></div>
        {archives.length === 0 ? (
          <p className="muted">No archived competitions yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Event</th><th>Date</th><th className="num">Teams</th><th className="num">Matches</th><th className="num">Reports</th><th></th></tr></thead>
              <tbody>
                {archives.map((a) => (
                  <tr key={a.event_key}>
                    <td>{a.name || a.event_key}</td>
                    <td className="mono">{a.event_key}</td>
                    <td>{new Date(a.archived_at).toLocaleDateString()}</td>
                    <td className="num mono">{a.team_count ?? a.counts?.teams ?? 0}</td>
                    <td className="num mono">{a.match_count ?? a.counts?.matches ?? 0}</td>
                    <td className="num mono">{a.scouting_count ?? a.counts?.scouting_entries ?? 0}</td>
                    <td><button className="btn sm" onClick={() => openArchiveDetail(a.event_key)} disabled={busy === `archive-${a.event_key}`}>Open Archive</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openArchive && <ArchiveViewer archive={openArchive} onClose={() => setOpenArchive(null)} />}

      {scheduleImportOpen && <Modal dialog onClose={() => busy !== "schedule-csv" && setScheduleImportOpen(false)}><div className="schedule-import-dialog"><div><h2>Import Match Schedule</h2><p className="muted">Choose a CSV for <b>{event.trim() || "the current event"}</b>. The entire file is checked before the current schedule changes.</p></div><section className="csv-format-help"><h3>CSV format</h3><p>The first row must contain these headers. <code>comp_level</code> is optional and defaults to <code>qm</code>.</p><pre>match_number,comp_level,red1,red2,red3,blue1,blue2,blue3{"\n"}1,qm,418,436,254,148,118,2848</pre><p>Use one row per match and positive team numbers. Qualification match numbers must be unique.</p></section><label className="schedule-file-picker"><span>Schedule CSV file</span><input type="file" accept=".csv,text/csv" disabled={busy === "schedule-csv"} onChange={e => setScheduleFile(e.target.files?.[0] || null)} /><small>{scheduleFile ? scheduleFile.name : "No file selected"}</small></label><div className="btn-row"><button className="btn primary" disabled={!scheduleFile || busy === "schedule-csv" || !event.trim()} onClick={() => scheduleFile && void importSchedule(scheduleFile)}>{busy === "schedule-csv" ? "Importing…" : "Import schedule"}</button><button className="btn" disabled={busy === "schedule-csv"} onClick={() => setScheduleImportOpen(false)}>Cancel</button></div></div></Modal>}

      {passwordResetOpen && (
        <Modal onClose={() => { if (busy !== "password-reset") setPasswordResetOpen(false); }}>
          <form onSubmit={resetUserPassword} role="dialog" aria-modal="true" aria-labelledby="password-reset-title">
            <h2 id="password-reset-title">Reset user password</h2>
            <p className="muted">
              Enter the user ID. Their current password will stop working, and the usual create-and-retype-password popup will appear the next time they sign in.
            </p>
            <label className="field">
              <span>User ID</span>
              <input
                autoFocus
                value={passwordResetId}
                onChange={(e) => { setPasswordResetId(e.target.value); setPasswordResetError(""); }}
                autoCapitalize="none"
                autoComplete="off"
                required
              />
            </label>
            {passwordResetError && <p role="alert">{passwordResetError}</p>}
            <div className="row">
              <button className="btn ghost" type="button" disabled={busy === "password-reset"} onClick={() => setPasswordResetOpen(false)}>Cancel</button>
              <button className="btn danger" type="submit" disabled={busy === "password-reset"}>
                {busy === "password-reset" ? "Resetting..." : "Reset password"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>Match Schedule</h3>
          <div className="row" style={{ gap: 10 }}>
            <span className="muted">Current match</span>
            <Stepper value={Math.max(1, curMatch || 1)} min={1} onChange={saveCurrent} />
          </div>
        </div>
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
          <table className="data">
            <thead><tr><th>Match</th><th>Red</th><th>Blue</th><th>Result</th><th>Bet Status</th></tr></thead>
            <tbody>
              {qm.map((m) => (
                <tr key={m.match_key} style={m.match_number === curMatch ? { fontWeight: 700 } : {}}>
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
                  <td>{m.winner ? <span className={`badge ${m.winner === "red" ? "red" : m.winner === "blue" ? "blue" : "muted"}`}>{m.winner}</span> : <span className="faint">-</span>}</td>
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
        <div className="card-h">
          <h3>Accounts</h3>
          <div className="row">
            <span className="badge muted">{scouters.length}</span>
            <button className="btn sm" onClick={() => { setPasswordResetId(""); setPasswordResetError(""); setPasswordResetOpen(true); }}>
              Reset user password
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Account</th><th>Role</th><th className="num">Matches</th><th className="num">Bucks</th></tr></thead>
            <tbody>
              {scouters.map((sc) => (
                <tr key={sc.scout_id}>
                  <td>{sc.display_name} <span className="faint mono">{sc.scout_id}</span></td>
                  <td>
                    <span className={"badge " + (sc.role === "admin" || sc.role === "strategy" ? "haze" : "muted")}>
                      {ROLE_LABEL[sc.role as Role] || "Scouter"}
                    </span>
                  </td>
                  <td className="num mono">{sc.matches_scouted}</td>
                  <td className="num mono">{sc.bucks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Betting is the last thing that matters at an event: it does not
          affect a single scouting decision, and putting it up top pushed the
          event and schedule controls below the fold. */}
      <div className="admin-betting">
        <h2 className="admin-section-title">Betting</h2>
      <div className="card">
        <h3>Betting Recovery</h3>

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
      </div>
    </div>
  );
}

function ArchiveViewer({ archive, onClose }: { archive: ArchiveDetail; onClose: () => void }) {
  const teamRows = Object.values(archive.teams || {}).sort((a: any, b: any) => (a.team || 0) - (b.team || 0));
  const matches = [...(archive.matches || [])].sort((a, b) => (a.match_num || 0) - (b.match_num || 0));
  const scouting = archive.scouting || [];
  const picklists = archive.picklists_raw || [];
  const dataAnalysis = archive.analytics?.data_analysis || [];

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <div>
          <h3>{archive.name || archive.event_key}</h3>
          <div className="meta">{archive.event_key} · read-only archive</div>
        </div>
        <button className="btn sm ghost" onClick={onClose}>Return to Live</button>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat label="Teams" value={archive.counts?.teams ?? teamRows.length} />
        <Stat label="Matches" value={archive.counts?.matches ?? matches.length} />
        <Stat label="Reports" value={archive.counts?.scouting_entries ?? scouting.length} />
        <Stat label="Pit Reports" value={archive.counts?.pit_reports ?? archive.pit_raw?.length ?? 0} />
      </div>

      <div className="table-wrap" style={{ maxHeight: 280, overflowY: "auto", marginBottom: 14 }}>
        <table className="data">
          <thead><tr><th>Team</th><th className="num">Matches</th><th className="num">Haze Power Rating</th><th className="num">Consistency</th><th className="num">Climb</th><th className="num">Failure</th></tr></thead>
          <tbody>
            {teamRows.map((t: any) => (
              <tr key={t.team}>
                <td className="mono">{t.team}</td>
                <td className="num mono">{t.matches ?? 0}</td>
                <td className="num mono">{Number(t.avg_points ?? 0).toFixed(1)}</td>
                <td className="num mono">{Math.round((t.consistency ?? 0) * 100)}%</td>
                <td className="num mono">{Math.round((t.climb_rate ?? 0) * 100)}%</td>
                <td className="num mono">{Math.round((t.failure_rate ?? 0) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid cols-2">
        <div>
          <div className="card-h"><h3>Matches</h3><span className="badge muted">{matches.length}</span></div>
          <div className="table-wrap" style={{ maxHeight: 240, overflowY: "auto" }}>
            <table className="data">
              <thead><tr><th>Match</th><th>Red</th><th>Blue</th><th>Result</th></tr></thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={m.match_key}>
                    <td>{matchLabel(m.comp_level || "qm", m.match_num || 0)}</td>
                    <td className="mono">{[m.red1, m.red2, m.red3].filter(Boolean).join(", ")}</td>
                    <td className="mono">{[m.blue1, m.blue2, m.blue3].filter(Boolean).join(", ")}</td>
                    <td>{m.winner || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="card-h"><h3>Scouting Reports</h3><span className="badge muted">{scouting.length}</span></div>
          <div className="table-wrap" style={{ maxHeight: 240, overflowY: "auto" }}>
            <table className="data">
              <thead><tr><th>Match</th><th>Team</th><th>Scout</th><th className="num">Points</th></tr></thead>
              <tbody>
                {scouting.slice(0, 300).map((r) => (
                  <tr key={r.submission_uuid}>
                    <td>{matchLabel(r.comp_level || "qm", r.match_num || 0)}</td>
                    <td className="mono">{r.team_num}</td>
                    <td>{r.scouter_id}</td>
                    <td className="num mono">{Number(r.points ?? 0).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div>
          <div className="card-h"><h3>Data Analysis Snapshot</h3><span className="badge muted">{dataAnalysis.length}</span></div>
          <div className="table-wrap" style={{ maxHeight: 220, overflowY: "auto" }}>
            <table className="data">
              <thead><tr><th>Team</th><th className="num">Skew</th><th className="num">Fail</th><th className="num">RP Pred</th></tr></thead>
              <tbody>
                {dataAnalysis.slice(0, 80).map((r: any) => (
                  <tr key={r.team}>
                    <td className="mono">{r.team}</td>
                    <td className="num mono">{Number(r.skew_distribution ?? 0).toFixed(3)}</td>
                    <td className="num mono">{Math.round((r.failure_rate ?? 0) * 100)}%</td>
                    <td className="num mono">{Number(r.ranking_point_prediction ?? 0).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="card-h"><h3>Picklists</h3><span className="badge muted">{picklists.length}</span></div>
          <div className="table-wrap" style={{ maxHeight: 220, overflowY: "auto" }}>
            <table className="data">
              <thead><tr><th>Name</th><th>Owner</th><th className="num">Teams</th></tr></thead>
              <tbody>
                {picklists.map((p) => (
                  <tr key={p.picklist_id}>
                    <td>{p.picklist_name}</td>
                    <td>{p.owner_id}</td>
                    <td className="num mono">{p.items?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
