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

export default function PicklistsPage() {
  const { session } = useAuth();
  const toast = useToast();
  const { confirm, confirmation } = usePicklistConfirm();
  const [lists, setLists] = useState<PicklistRecord[]>([]);
  const [selected, setSelected] = useState<number>();
  const [submitted, setSubmitted] = useState<PicklistRecord[]>([]);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState("");
  const [requestId, setRequestId] = useState("");
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
  async function duplicate() {
    if (!active) return;
    try { const row = await api<PicklistRecord>("/api/picklists", { method: "POST", body: { ...active, name: `${active.name.slice(0, 90)} copy` } }); setLists(v => [...v, row]); setSelected(row.id); }
    catch (e: any) { toast(e.message, "err"); }
  }
  async function submit() {
    if (!active || busy) return;
    setBusy(true);
    try {
      if (edits.pending && !await edits.flush()) throw new Error("Save your draft before submitting");
      const drafts = await api<PicklistRecord[]>(`/api/picklists/mine?event=${encodeURIComponent(active.event_key)}`);
      const latest = drafts.find(l => l.id === active.id)!;
      await api(`/api/picklists/${active.id}/submit`, { method: "POST", body: { ...latest, name, request_id: requestId } });
      setDialog(false); toast("Picklist submitted", "ok"); await load();
    } catch (e: any) { toast(e.message, "err"); }
    finally { setBusy(false); }
  }
  if (!active) return error ? <p role="alert">{error}</p> : <Loading />;
  return <div>
    <div className="page-title"><h1>Picklists</h1><Link className="btn primary" href="/meeting">Picklist Meeting Mode</Link></div>
    <FinalPicklists teams={teams} />
    {error && <p role="alert">{error}</p>}
    <div className="card">
      <div className="btn-row" style={{ flexWrap: "wrap" }}>
        <select aria-label="Open draft" value={active.id} onChange={e => setSelected(Number(e.target.value))}>{lists.map(l => <option key={l.id} value={l.id}>{l.pick_round === 1 ? "First" : "Second"} Pick · {l.name}</option>)}</select>
        <span role="status" className="badge muted">{edits.status}</span>
        {edits.pending && <><button className="btn sm" onClick={() => edits.flush()}>Retry save</button><button className="btn sm ghost" onClick={async () => { if (await confirm("Discard recovered or unsaved draft changes?")) { edits.discard(); void load(); } }}>Discard changes</button></>}
        <button className="btn" onClick={duplicate}>Duplicate draft</button>
        <button className="btn primary" disabled={locked || busy || !active.items.length} onClick={() => { setName(`${(session?.display_name || session?.scout_id || "Scout").replace(/\s/g, "")}_${active.pick_round === 1 ? "FirstPick" : "SecondPick"}`); setRequestId(crypto.randomUUID()); setDialog(true); }}>Submit Picklist</button>
      </div>
      <p className="faint">{event} · {locked ? "Submissions are locked. You can still edit your draft." : "Your drafts are private. Submitting saves a separate version for Admin to reference."}</p>
      <label>Draft name<input value={active.name} maxLength={100} onChange={e => edits.enqueue({ ...edits.pending, [active.id]: { ...active, name: e.target.value } })} /></label>
      <PicklistBoard key={active.id} list={active} teams={teams} pool={pool} canEdit={active.owner_id === session?.scout_id} onChange={items => edits.enqueue({ ...edits.pending, [active.id]: { ...active, items, updated_at: new Date().toISOString() } })} />
    </div>
    <section className="card" style={{ marginTop: 16 }}><h2>Your submissions</h2>
      {!submitted.length && <p className="faint">No submissions yet.</p>}
      {submitted.map(l => <details key={l.id}><summary>{l.name} · {l.pick_round === 1 ? "First" : "Second"} Pick · v{l.version} {l.latest ? "· Latest" : ""} · {new Date(l.updated_at).toLocaleString()}</summary><PicklistBoard list={l} teams={teams} pool={[]} canEdit={false} onChange={() => {}} /></details>)}
    </section>
    {dialog && <Modal dialog onClose={() => { if (!busy) setDialog(false); }}><h2>Submit Picklist</h2><p>{active.pick_round === 1 ? "First Pick" : "Second Pick"} · {event} · {active.items.length} teams</p><label>Submission name<input autoFocus maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label><ol>{active.items.map(i => <li key={i.team}>{i.team} {teams[i.team]?.nickname}</li>)}</ol><p className="faint">This saves a new, read-only version. Meeting changes will never change this submission.</p><div className="btn-row"><button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? "Submitting…" : "Confirm submission"}</button><button className="btn" disabled={busy} onClick={() => setDialog(false)}>Cancel</button></div></Modal>}
    {confirmation}
  </div>;
}
