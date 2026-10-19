"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useLiveRefetch } from "@/lib/bus";
import { Loading, Empty, Modal } from "@/components/ui";
import { ClickableTeam } from "@/components/TeamDetailModal";
import { LineChart } from "@/components/Chart";
import { useAuth } from "@/lib/auth";

interface RawData { event: string; generated_at: string; entries: Record<string, any>[]; pit_entries: Record<string, any>[] }
type Mode = "raw" | "beautiful";

export default function DataPage() {
  const [data, setData] = useState<RawData | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("match");
  const [status, setStatus] = useState("all");
  const { session } = useAuth();
  const [mode, setMode] = useState<Mode>("raw");
  const [error, setError] = useState("");
  const [offlineSaved, setOfflineSaved] = useState<number | null>(null);
  const load = useCallback(() => { api<RawData>("/api/admin/raw-data").then(result => { setData(result); setError(""); }).catch((e: any) => setError(e?.message || "Could not load scouting data")); }, []);
  useLiveRefetch(load, ["scout_submitted", "scouting_corrected", "pit_submitted", "settings_changed"]);
  useEffect(() => {
    setMode(localStorage.getItem("hazehub.data.mode") === "beautiful" ? "beautiful" : "raw");
    const used = (event: Event) => setOfflineSaved((event as CustomEvent).detail || Date.now());
    window.addEventListener("offline-snapshot", used); return () => window.removeEventListener("offline-snapshot", used);
  }, []);
  const rows = useMemo(() => (data?.entries || []).filter(row => (!query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase())) && (status === "all" || (status === "flagged" ? row.review?.flagged : status === "voided" ? row.review?.voided : !row.review?.flagged && !row.review?.voided))).sort((a, b) => sort === "team" ? Number(a.team_number) - Number(b.team_number) : sort === "points" ? Number(b.points || 0) - Number(a.points || 0) : Number(a.match_number || 0) - Number(b.match_number || 0)), [data, query, sort, status]);
  const pitRows = useMemo(() => (data?.pit_entries || []).filter(row => !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase())), [data, query]);
  const summaries = useMemo(() => {
    const grouped = new Map<number, Record<string, any>[]>();
    for (const row of rows) grouped.set(Number(row.team_number), [...(grouped.get(Number(row.team_number)) || []), row]);
    return [...grouped].map(([team, reports]) => ({ team, reports, average: reports[0]?.expected_avg_points ?? null, failures: reports.filter(row => row.failure || row.robot_failure).length })).sort((a, b) => Number(b.average ?? -1) - Number(a.average ?? -1));
  }, [rows]);
  function selectMode(next: Mode) { setMode(next); localStorage.setItem("hazehub.data.mode", next); }
  function download(kind: "json" | "csv") {
    if (!data) return;
    const text = kind === "json" ? JSON.stringify(data, null, 2) : ["event_key,match_number,comp_level,team_number,alliance,station,scout_id,points,notes", ...data.entries.map(row => [row.event_key, row.match_number, row.comp_level, row.team_number, row.alliance, row.station, row.scout_id, row.points, row.notes].map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: kind === "json" ? "application/json" : "text/csv" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${data.event || "event"}-scouting.${kind}`; anchor.click(); URL.revokeObjectURL(url);
  }
  if (!data && !error) return <Loading label="Loading scouting data" />;
  return <div>
    <div className="page-title"><h1>Data</h1><div className="seg" aria-label="Data display"><button className={mode === "raw" ? "on" : ""} onClick={() => selectMode("raw")}>Raw</button><button className={mode === "beautiful" ? "on" : ""} onClick={() => selectMode("beautiful")}>Beautiful</button></div></div>
    <section className="card"><div className="card-h"><div><h2 style={{ margin: 0 }}>{data?.event || "Current event"}</h2><p className="faint" style={{ margin: 0 }}>{data ? `${data.entries.length} match reports · ${(data.pit_entries || []).length} pit reports · updated ${new Date(data.generated_at).toLocaleTimeString()}` : ""}</p></div>{offlineSaved && <span className="badge amber">Saved {new Date(offlineSaved).toLocaleTimeString()}</span>}</div>{error && <p role="alert">{error}</p>}<div className="btn-row"><input aria-label="Filter data" placeholder="Filter any field" value={query} onChange={e => setQuery(e.target.value)} /><label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="all">All</option><option value="active">Active</option><option value="flagged">Flagged</option><option value="voided">Voided</option></select></label><label>Sort<select value={sort} onChange={e => setSort(e.target.value)}><option value="match">Match</option><option value="team">Team</option><option value="points">Points</option></select></label><button className="btn" onClick={() => download("csv")}>Download CSV</button><button className="btn" onClick={() => download("json")}>Download JSON</button></div></section>
    {mode === "raw" ? <RawTables rows={rows} pitRows={pitRows} admin={session?.role === "admin"} reload={load} /> : <Beautiful summaries={summaries} pitRows={pitRows} />}
  </div>;
}

function RawTables({ rows, pitRows, admin, reload }: { rows: Record<string, any>[]; pitRows: Record<string, any>[]; admin: boolean; reload: () => void }) {
  return <>{!rows.length ? <Empty title="No matching scouting records" /> : <div className="table-wrap" style={{ marginTop: 16 }}><table className="data"><thead><tr><th>Match</th><th>Team</th><th>Alliance</th><th>Scout</th><th>Points</th><th>Recorded</th><th>Raw record</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.client_uuid || row.id || index}><td>{String(row.comp_level || "qm").toUpperCase()} {row.match_number}</td><td>{row.team_number}</td><td>{row.alliance} {row.station}</td><td>{row.scout_id}</td><td>{row.points ?? "—"}</td><td>{row.created_at ? new Date(row.created_at).toLocaleString() : "—"}</td><td><details><summary>View all fields</summary><pre className="raw-record">{JSON.stringify(row, null, 2)}</pre></details>{admin && <AdminReview row={row} reload={reload} />}</td></tr>)}</tbody></table></div>}<h2 style={{ marginTop: 24 }}>Pit scouting</h2>{!pitRows.length ? <Empty title="No matching pit reports" /> : <div className="table-wrap"><table className="data"><thead><tr><th>Team</th><th>Scout</th><th>Drivetrain</th><th>Photos</th><th>Recorded</th><th>Raw record</th></tr></thead><tbody>{pitRows.map((row, index) => <tr key={`${row.team_number}-${index}`}><td>{row.team_number}</td><td>{row.scout_id || "—"}</td><td>{row.drivetrain || "—"}</td><td>{row.photo_count || 0}</td><td>{row.updated_at ? new Date(row.updated_at).toLocaleString() : "—"}</td><td><details><summary>View all fields</summary><pre className="raw-record">{JSON.stringify(row, null, 2)}</pre></details></td></tr>)}</tbody></table></div>}</>;
}

function AdminReview({ row, reload }: { row: Record<string, any>; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [actions, setActions] = useState<Record<string, any>[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function act(action: string, reasonOverride?: string, patch: Record<string, any> = {}) {
    const reason = reasonOverride ?? window.prompt(`${action === "resolve" ? "Resolve flag" : action} reason (required)`);
    if (!reason?.trim()) return false;
    setBusy(true); setError("");
    try {
      await api(`/api/admin/scouting-data/${row.submission_id}/${action}`, { method: "POST", body: { reason, category: "admin_review", expected_revision: row.review?.revision || 0, patch } });
      setEditing(false); reload(); return true;
    } catch (e: any) {
      setError(e?.message || "Could not save this change"); return false;
    } finally { setBusy(false); }
  }

  async function openAudit() {
    setAuditOpen(true); setActions(null); setError("");
    try {
      const result = await api<{ actions: Record<string, any>[] }>(`/api/admin/scouting-data/${row.submission_id}/audit`);
      setActions(result.actions);
    } catch (e: any) { setError(e?.message || "Could not load the audit history"); setActions([]); }
  }

  return <div className="admin-review-actions">
    <p style={{ margin: "8px 0 0" }}>{row.review?.voided ? <span className="badge red">Voided</span> : row.review?.flagged ? <span className="badge amber">Flagged</span> : <span className="badge green">Active</span>}</p>
    <div className="btn-row" style={{ marginTop: 8 }}>
      {row.review?.voided ? <button className="btn sm" disabled={busy} onClick={() => act("restore")}>Restore</button> : <button className="btn sm danger" disabled={busy} onClick={() => act("void")}>Void</button>}
      <button className="btn sm" disabled={busy || row.review?.voided} onClick={() => { setError(""); setEditing(true); }}>Edit</button>
      {row.review?.flagged ? <button className="btn sm" disabled={busy} onClick={() => act("resolve")}>Resolve flag</button> : <button className="btn sm" disabled={busy} onClick={() => act("flag")}>Flag</button>}
      <button className="btn sm" disabled={busy} onClick={openAudit}>Audit</button>
    </div>
    {error && !editing && !auditOpen && <p className="form-error" role="alert">{error}</p>}
    {editing && <EditReportModal row={row} busy={busy} error={error} onClose={() => !busy && setEditing(false)} onSave={(reason, patch) => act("edit", reason, patch)} />}
    {auditOpen && <AuditModal row={row} actions={actions} error={error} onClose={() => setAuditOpen(false)} />}
  </div>;
}

function EditReportModal({ row, busy, error, onClose, onSave }: { row: Record<string, any>; busy: boolean; error: string; onClose: () => void; onSave: (reason: string, patch: Record<string, any>) => Promise<boolean> }) {
  const [form, setForm] = useState(() => ({
    team_number: Number(row.team_number || 1), match_number: Number(row.match_number || 1), comp_level: row.comp_level || "qm",
    alliance: row.alliance || "red", station: Number(row.station || 1), climb: row.climb || "none",
    auto_missed: Number(row.auto_missed || 0), teleop_missed: Number(row.teleop_missed || 0), fouls: Number(row.fouls || 0),
    driver_skill: Number(row.driver_skill || 3), speed_rating: Number(row.speed_rating || 3), successful_stops: Number(row.successful_stops || 0),
    played_defense: Boolean(row.played_defense), failure: Boolean(row.failure), no_show: Boolean(row.no_show), notes: String(row.notes || ""),
  }));
  const [reason, setReason] = useState("");
  const [clearHeatmap, setClearHeatmap] = useState(false);
  const [validation, setValidation] = useState("");
  const set = (key: keyof typeof form, value: any) => setForm(current => ({ ...current, [key]: value }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const candidate: Record<string, any> = {
      team_number: form.team_number, match_number: form.match_number, comp_level: form.comp_level, alliance: form.alliance, station: form.station,
      climb: form.climb, auto_missed: form.auto_missed, teleop_missed: form.teleop_missed, foul_count: form.fouls,
      driver_skill: form.driver_skill, speed_rating: form.speed_rating, successful_stops: form.successful_stops,
      played_defense: form.played_defense, failure: form.failure, no_show: form.no_show, notes: form.notes,
    };
    const current: Record<string, any> = { ...row, foul_count: row.fouls };
    const patch = Object.fromEntries(Object.entries(candidate).filter(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value)));
    if (clearHeatmap && (row.heatmap || []).length) patch.heatmap = [];
    if (!Object.keys(patch).length) { setValidation("Change at least one field before saving."); return; }
    setValidation("");
    await onSave(reason, patch);
  }
  return <Modal dialog onClose={onClose}><form className="data-edit-dialog" onSubmit={submit}>
    <div className="modal-head"><div><span className="badge haze">Team {row.team_number} · {String(row.comp_level || "qm").toUpperCase()} {row.match_number}</span><h2>Edit scouting report</h2><p>Use the controls below. The original report remains in the audit history.</p></div><button className="btn sm" type="button" disabled={busy} onClick={onClose}>Close</button></div>
    <section><h3>Assignment</h3><div className="data-edit-grid">
      <label>Team number<input type="number" min={1} required value={form.team_number} onChange={e => set("team_number", Number(e.target.value))} /></label>
      <label>Match number<input type="number" min={1} required value={form.match_number} onChange={e => set("match_number", Number(e.target.value))} /></label>
      <label>Level<select value={form.comp_level} onChange={e => set("comp_level", e.target.value)}><option value="qm">Qualification</option><option value="qf">Quarterfinal</option><option value="sf">Semifinal</option><option value="f">Final</option></select></label>
      <label>Alliance<select value={form.alliance} onChange={e => set("alliance", e.target.value)}><option value="red">Red</option><option value="blue">Blue</option></select></label>
      <label>Station<select value={form.station} onChange={e => set("station", Number(e.target.value))}>{[1,2,3].map(value => <option key={value}>{value}</option>)}</select></label>
    </div></section>
    <section><h3>Scoring and robot</h3><div className="data-edit-grid">
      <label>Climb<input value={form.climb} onChange={e => set("climb", e.target.value)} /></label>
      <label>Auto misses<input type="number" min={0} value={form.auto_missed} onChange={e => set("auto_missed", Number(e.target.value))} /></label>
      <label>Teleop misses<input type="number" min={0} value={form.teleop_missed} onChange={e => set("teleop_missed", Number(e.target.value))} /></label>
      <label>Fouls<input type="number" min={0} value={form.fouls} onChange={e => set("fouls", Number(e.target.value))} /></label>
      <label>Driver skill<input type="number" min={1} max={5} value={form.driver_skill} onChange={e => set("driver_skill", Number(e.target.value))} /></label>
      <label>Speed rating<input type="number" min={1} max={5} value={form.speed_rating} onChange={e => set("speed_rating", Number(e.target.value))} /></label>
      <label>Defense stops<input type="number" min={0} value={form.successful_stops} onChange={e => set("successful_stops", Number(e.target.value))} /></label>
    </div><div className="data-edit-checks">
      <label><input type="checkbox" checked={form.played_defense} onChange={e => set("played_defense", e.target.checked)} /> Played defense</label>
      <label><input type="checkbox" checked={form.failure} onChange={e => set("failure", e.target.checked)} /> Robot failure</label>
      <label><input type="checkbox" checked={form.no_show} onChange={e => set("no_show", e.target.checked)} /> No-show</label>
    </div></section>
    <section className="heatmap-edit-row"><div><h3>Heatmap</h3><p>{(row.heatmap || []).length} saved dot{(row.heatmap || []).length === 1 ? "" : "s"}. Clearing also removes these dots from analytics.</p></div><label className="pill-check danger"><input type="checkbox" checked={clearHeatmap} onChange={e => setClearHeatmap(e.target.checked)} /> Clear all heatmap dots</label></section>
    <label>Scout notes<textarea rows={3} maxLength={5000} value={form.notes} onChange={e => set("notes", e.target.value)} /></label>
    <label>Reason for this correction <span className="required">Required</span><textarea rows={2} required minLength={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Explain what was wrong and how you verified the correction" /></label>
    {(error || validation) && <p className="form-error" role="alert">{error || validation}</p>}
    <div className="btn-row data-edit-footer"><button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || reason.trim().length < 2}>{busy ? "Saving…" : "Save correction"}</button></div>
  </form></Modal>;
}

function AuditModal({ row, actions, error, onClose }: { row: Record<string, any>; actions: Record<string, any>[] | null; error: string; onClose: () => void }) {
  return <Modal dialog onClose={onClose}><div className="audit-dialog">
    <div className="modal-head"><div><span className="badge haze">Team {row.team_number} · {String(row.comp_level || "qm").toUpperCase()} {row.match_number}</span><h2>Report history</h2><p>Every admin action is permanent and the original scout submission is preserved.</p></div><button className="btn sm" onClick={onClose}>Close</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {actions === null ? <Loading label="Loading report history" /> : !actions.length ? <Empty title="No admin changes yet" sub="This report still matches the original scout submission." /> : <div className="audit-timeline">{actions.map((action, index) => <article key={`${action.created_at}-${index}`} className="audit-event">
      <div className="audit-event-head"><span className={`badge ${action.action === "void" ? "red" : action.action === "flag" ? "amber" : "haze"}`}>{String(action.action || "change").replaceAll("_", " ")}</span><time>{new Date(action.created_at).toLocaleString()}</time></div>
      <b>{action.actor_name || action.actor_id || "Admin"}</b><p>{action.reason}</p>
      {!!Object.keys(action.patch || {}).length && <dl>{Object.entries(action.patch).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><span>{prettyValue(action.before?.[key])}</span><b>→</b><span>{prettyValue(value)}</span></dd></div>)}</dl>}
    </article>)}</div>}
    <div className="btn-row" style={{ justifyContent: "flex-end" }}><button className="btn primary" onClick={onClose}>Done</button></div>
  </div></Modal>;
}

function prettyValue(value: any): string {
  if (value === undefined) return "Not recorded";
  if (value === null) return "None";
  if (Array.isArray(value)) return value.length ? `${value.length} item${value.length === 1 ? "" : "s"}` : "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Beautiful({ summaries, pitRows }: { summaries: { team: number; reports: Record<string, any>[]; average: number | null; failures: number }[]; pitRows: Record<string, any>[] }) {
  if (!summaries.length) return <Empty title="No matching scouting records" />;
  return <div className="beautiful-data-grid">{summaries.map(summary => {
    const pit = pitRows.find(row => Number(row.team_number) === summary.team);
    const ordered = [...summary.reports].sort((a, b) => Number(a.match_number) - Number(b.match_number));
    return <article className="card beautiful-team" key={summary.team}>
      <div className="card-h"><ClickableTeam team={{ team_number: summary.team, nickname: "" }} size="lg" /><span className="badge haze">{summary.reports.length} reports</span></div>
      <div className="grid cols-3"><div className="stat"><span>Haze Power Rating</span><b>{summary.average == null ? "—" : summary.average.toFixed(1)}</b></div><div className="stat"><span>Failures</span><b>{summary.failures}</b></div><div className="stat"><span>Pit Photos</span><b>{pit?.photo_count || 0}</b></div></div>
      <LineChart data={ordered.map(row => ({ x: `Q${row.match_number}`, y: Number(row.points || 0) }))} height={130} label={`Team ${summary.team} points by match`} />
      <div className="beautiful-report-list"><h3>Scouting forms</h3><p className="faint">Each form stays minimized until you open it. Every saved answer is shown exactly as the scouter submitted it.</p>{ordered.map((row, index) => <ScoutingFormDetails key={row.client_uuid || row.id || index} row={row} title={`${String(row.comp_level || "qm").toUpperCase()} ${row.match_number} · ${row.scout_id || "Unknown scout"}`} />)}</div>
      {pit && <div className="beautiful-report-list"><h3>Pit scouting form</h3><ScoutingFormDetails row={pit} title={`Team ${summary.team} pit report · ${pit.scout_id || "Unknown scout"}`} /></div>}
    </article>;
  })}</div>;
}

function ScoutingFormDetails({ row, title }: { row: Record<string, any>; title: string }) {
  return <details className="beautiful-form"><summary><span>{title}</span><b>{row.points === undefined ? "Open form" : `${row.points} points`}</b></summary><dl>{Object.entries(row).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{value === null ? "null" : typeof value === "object" ? <pre>{JSON.stringify(value, null, 2)}</pre> : String(value)}</dd></div>)}</dl></details>;
}
