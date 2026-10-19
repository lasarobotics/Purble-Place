"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { usePicklistConfirm } from "@/components/PicklistConfirm";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { usePicklistLive, usePicklistTeams, useRecoveredEdit } from "@/lib/picklists";
import type { PicklistRecord, PicklistMeetingState } from "@/lib/types";
import { Loading, Modal } from "@/components/ui";
import { PicklistBoard } from "@/components/PicklistBoard";
import { FinalPicklists } from "@/components/FinalPicklists";

const robotLabel = (list: PicklistRecord) => `${list.robot_number || 418} · ${list.robot_name || "Purple Haze"}`;
const workspaceKey = (list: PicklistRecord) => list.workspace_id || `legacy-${list.id}`;

export default function PicklistsPage() {
  const { session } = useAuth();
  const toast = useToast();
  const { confirm, confirmation } = usePicklistConfirm();
  const [lists, setLists] = useState<PicklistRecord[]>([]);
  const [selected, setSelected] = useState<number>();
  const [submitted, setSubmitted] = useState<PicklistRecord[]>([]);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [submitDialog, setSubmitDialog] = useState(false);
  const [createDialog, setCreateDialog] = useState(false);
  const [submissionName, setSubmissionName] = useState("");
  const [submissionRobot, setSubmissionRobot] = useState("");
  const [requestId, setRequestId] = useState("");
  const [newName, setNewName] = useState("My Picklist");
  const [newRobot, setNewRobot] = useState(418);
  const [newRobotName, setNewRobotName] = useState("Purple Haze");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [drafts, submissions, meeting] = await Promise.all([
        api<PicklistRecord[]>("/api/picklists/mine"), api<PicklistRecord[]>("/api/picklists/submissions"), api<PicklistMeetingState>("/api/picklists/meeting"),
      ]);
      setLists(drafts); setSubmitted(submissions); setLocked(meeting.locked); setError("");
    } catch (e: any) { setError(e.message); }
  }, []);
  usePicklistLive(load);
  const event = lists[0]?.event_key;
  const { pool, teams } = usePicklistTeams(event);
  const edits = useRecoveredEdit<Record<string, PicklistRecord>>(`hazehub.picklist.drafts:${session?.scout_id}:${event || "loading"}`, async changes => {
    const results = await api<PicklistRecord[]>("/api/picklists/drafts", { method: "POST", body: { event_key: Object.values(changes)[0].event_key, drafts: Object.values(changes) } });
    const versions = Object.fromEntries(results.map(r => [r.id, r.version]));
    setLists(rows => rows.map(r => results.find(saved => saved.id === r.id) || r));
    return latest => Object.fromEntries(Object.entries(latest).map(([id, row]) => [id, { ...row, version: versions[id] ?? row.version }]));
  });
  const original = lists.find(l => l.id === selected) || lists[0];
  const active = original && (edits.pending?.[original.id] || original);
  const workspaces = lists.filter((list, index) => lists.findIndex(candidate => workspaceKey(candidate) === workspaceKey(list)) === index);

  async function createDraft(source?: PicklistRecord) {
    setBusy(true);
    try {
      const sourceRows = source?.status === "Draft" ? lists.filter(row => workspaceKey(row) === workspaceKey(source)) : source ? [source] : [];
      const rows = await api<PicklistRecord[]>("/api/picklists/workspace", { method: "POST", body: {
        event_key: source?.event_key || event, name: source ? `${source.name.slice(0, 90)} copy` : newName,
        robot_number: source?.robot_number || newRobot, robot_name: source?.robot_name || newRobotName,
        first_items: sourceRows.find(row => row.pick_round === 1)?.items || [], second_items: sourceRows.find(row => row.pick_round === 2)?.items || [],
      } });
      setLists(current => [...current, ...rows]); setSelected(rows.find(row => row.pick_round === (source?.pick_round || 1))?.id || rows[0].id); setCreateDialog(false);
      toast(source ? "Picklist copied with First and Second Pick tabs" : "Picklist created with both pick rounds", "ok");
    } catch (e: any) { toast(e.message, "err"); }
    finally { setBusy(false); }
  }
  async function removeDraft() {
    if (!active || !await confirm(`Delete “${active.name}” and both of its pick-round tabs? Submitted lists will stay unchanged.`)) return;
    try {
      if (active.workspace_id) await api(`/api/picklists/workspace/${encodeURIComponent(active.workspace_id)}?event=${encodeURIComponent(active.event_key)}`, { method: "DELETE" });
      else await api(`/api/picklists/${active.id}?event=${encodeURIComponent(active.event_key)}`, { method: "DELETE" });
      const key = workspaceKey(active); setLists(rows => rows.filter(row => workspaceKey(row) !== key)); setSelected(undefined); toast("Picklist deleted", "ok");
    } catch (e: any) { toast(e.message, "err"); }
  }
  function switchRound(round: 1 | 2) {
    const next = lists.find(row => active && workspaceKey(row) === workspaceKey(active) && row.pick_round === round);
    if (next) setSelected(next.id);
  }
  function renameWorkspace(name: string) {
    if (!active) return;
    const key = workspaceKey(active); const changes = { ...edits.pending };
    for (const row of lists.filter(candidate => workspaceKey(candidate) === key)) changes[row.id] = { ...(edits.pending?.[row.id] || row), name };
    edits.enqueue(changes);
  }
  async function submit() {
    if (!active || busy) return;
    setBusy(true);
    try {
      if (edits.pending && !await edits.flush()) throw new Error("Save your draft before submitting");
      const drafts = await api<PicklistRecord[]>(`/api/picklists/mine?event=${encodeURIComponent(active.event_key)}`);
      const latest = drafts.find(l => l.id === active.id)!;
      await api(`/api/picklists/${active.id}/submit`, { method: "POST", body: { ...latest, name: submissionName, robot_number: Number(submissionRobot), request_id: requestId } });
      setSubmitDialog(false); toast("Picklist submitted", "ok"); await load();
    } catch (e: any) { toast(e.message, "err"); }
    finally { setBusy(false); }
  }
  if (!active) return error ? <p role="alert">{error}</p> : <Loading />;
  return <div>
    <div className="page-title"><h1>Picklists</h1><div className="btn-row"><button className="btn" onClick={() => setCreateDialog(true)}>New picklist</button></div></div>
    <FinalPicklists teams={teams} />
    {error && <p role="alert">{error}</p>}
    <div className="card">
      <div className="pick-round-tabs" role="tablist" aria-label="Picklist round"><button role="tab" aria-selected={active.pick_round === 1} className={active.pick_round === 1 ? "on" : ""} onClick={() => switchRound(1)}>First Pick</button><button role="tab" aria-selected={active.pick_round === 2} className={active.pick_round === 2 ? "on" : ""} onClick={() => switchRound(2)}>Second Pick</button></div>
      <div className="btn-row" style={{ flexWrap: "wrap" }}>
        <select aria-label="Open picklist" value={workspaceKey(active)} onChange={e => { const rows = lists.filter(row => workspaceKey(row) === e.target.value); setSelected((rows.find(row => row.pick_round === active.pick_round) || rows[0]).id); }}>{workspaces.map(l => { const draft = edits.pending?.[l.id] || l; return <option key={workspaceKey(l)} value={workspaceKey(l)}>{robotLabel(draft)} · {draft.name}</option>; })}</select>
        <span role="status" className="badge muted">{edits.status}</span>
        {edits.pending && <><button className="btn sm" onClick={() => edits.flush()}>Retry save</button><button className="btn sm ghost" onClick={async () => { if (await confirm("Discard recovered or unsaved draft changes?")) { edits.discard(); void load(); } }}>Discard changes</button></>}
        <button className="btn" onClick={() => createDraft(active)}>Duplicate picklist</button>
        <button className="btn danger" onClick={removeDraft}>Delete picklist</button>
        <button className="btn primary" disabled={locked || busy || !active.items.length} onClick={() => { setSubmissionName(`${(session?.display_name || session?.scout_id || "Scout").replace(/\s/g, "")}_${active.pick_round === 1 ? "FirstPick" : "SecondPick"}`); setSubmissionRobot(""); setRequestId(crypto.randomUUID()); setSubmitDialog(true); }}>Submit Picklist</button>
      </div>
      <p className="faint">{event} · {robotLabel(active)} · {locked ? "Submissions are locked. You can still edit your draft." : "Drafts are private and independent. You can make as many picklists as you need."}</p>
      <label>Picklist name<input value={active.name} maxLength={100} onChange={e => renameWorkspace(e.target.value)} /></label>
      <aside className="match-ref-help" aria-label="Match References instructions"><b>Match References</b><p>In a team note, type <code>@</code> and a qualification match number, then choose the statistic you want to link. For example, <code>@42:climb</code> links this team’s climb result from Qual 42. Anyone viewing the picklist can click the finished reference to open the scouting evidence.</p><details><summary>More ways to reference scouting data</summary><p>Use <code>@42</code> to link the complete Qual 42 report. Use <code>@all:climb</code> to show that team’s climb result across every scouted match. Keep typing after the colon to filter the statistic list.</p></details></aside>
      <PicklistBoard key={active.id} list={active} teams={teams} pool={pool} canEdit={active.owner_id === session?.scout_id} onChange={items => edits.enqueue({ ...edits.pending, [active.id]: { ...active, items, updated_at: new Date().toISOString() } })} />
    </div>
    <section className="card" style={{ marginTop: 16 }}><h2>Your submissions</h2>{!submitted.length && <p className="faint">No submissions yet.</p>}{submitted.map(l => <details key={l.id}><summary>{l.owner_name} · {l.name} · For Team {l.robot_number || 418} · {l.pick_round === 1 ? "First" : "Second"} Pick #{l.submission_number || 1} · {new Date(l.submitted_at || l.updated_at).toLocaleString()}</summary><PicklistBoard list={l} teams={teams} pool={[]} canEdit={false} onChange={() => {}} /><button className="btn sm" onClick={() => createDraft(l)}>Duplicate into new draft</button></details>)}</section>
    {createDialog && <Modal dialog onClose={() => !busy && setCreateDialog(false)}><div className="picklist-create-dialog"><div><h2>New Picklist</h2><p className="faint">This creates one workspace with separate First Pick and Second Pick tabs.</p></div><label>Picklist name<input autoFocus maxLength={100} value={newName} onChange={e => setNewName(e.target.value)} /></label><label>Robot team number<input type="number" min={1} max={99999} value={newRobot} onChange={e => setNewRobot(Number(e.target.value))} /></label><label>Robot name<input maxLength={100} value={newRobotName} onChange={e => setNewRobotName(e.target.value)} /></label><div className="btn-row"><button className="btn primary" disabled={busy || !newName.trim() || newRobot < 1 || !newRobotName.trim()} onClick={() => createDraft()}>Create picklist</button><button className="btn" disabled={busy} onClick={() => setCreateDialog(false)}>Cancel</button></div></div></Modal>}
    {submitDialog && <Modal dialog onClose={() => !busy && setSubmitDialog(false)}><div className="picklist-submit-dialog"><div><h2>Submit Picklist</h2><p className="faint">Name this snapshot and enter the team the strategy was made for. Your signed-in account is recorded automatically.</p></div><label>Submission name<input autoFocus maxLength={100} value={submissionName} onChange={e => setSubmissionName(e.target.value)} /></label><label>Made for team number<input aria-label="Made for team number" type="number" min={1} max={99999} inputMode="numeric" placeholder="Example: 418 or 436" value={submissionRobot} onChange={e => setSubmissionRobot(e.target.value)} /></label><dl className="submit-picklist-summary"><div><dt>Made for</dt><dd>{Number(submissionRobot) > 0 ? `Team ${Number(submissionRobot)}` : "Enter a team"}</dd></div><div><dt>Pick Round</dt><dd>{active.pick_round === 1 ? "First Pick" : "Second Pick"}</dd></div><div><dt>Ranked Teams</dt><dd>{active.items.length}</dd></div></dl><p className="faint">Submitting creates a read-only snapshot. Future draft or final-list changes cannot alter it.</p><div className="btn-row"><button className="btn primary" disabled={busy || !submissionName.trim() || Number(submissionRobot) < 1 || Number(submissionRobot) > 99999} onClick={submit}>{busy ? "Submitting…" : "Confirm submission"}</button><button className="btn" disabled={busy} onClick={() => setSubmitDialog(false)}>Cancel</button></div></div></Modal>}
    {confirmation}
  </div>;
}
