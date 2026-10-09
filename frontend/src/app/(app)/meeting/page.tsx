"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePicklistConfirm } from "@/components/PicklistConfirm";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { usePicklistLive, usePicklistTeams, useRecoveredEdit } from "@/lib/picklists";
import type { PicklistItem, PicklistMeetingState } from "@/lib/types";
import { Loading, Modal } from "@/components/ui";
import { PicklistBoard } from "@/components/PicklistBoard";
import { SubmittedPicklists } from "@/components/SubmittedPicklists";
import { TeamDetailModal } from "@/components/TeamDetailModal";
import { FinalPicklists } from "@/components/FinalPicklists";

export default function MeetingPage() {
  const { session } = useAuth();
  const isAdmin = session?.scout_id === "Admin" && session?.role === "admin";
  const toast = useToast();
  const { confirm, confirmation } = usePicklistConfirm();
  const [meeting, setMeeting] = useState<PicklistMeetingState>();
  const current = useRef(meeting); current.current = meeting;
  const client = useRef("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [publish, setPublish] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [hide, setHide] = useState(false);
  const [details, setDetails] = useState<number>();
  const [teamInput, setTeamInput] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("Available");
  const load = useCallback(async () => {
    try {
      if (!client.current) client.current = crypto.randomUUID();
      const next = await api<PicklistMeetingState>(`/api/picklists/meeting?client=${client.current}`);
      setMeeting(old => !old || next.event_key !== old.event_key || next.version >= old.version ? next : old);
      setError("");
    } catch (e: any) { setError(e.message); }
  }, []);
  usePicklistLive(load, 10000);
  const { pool, teams } = usePicklistTeams(meeting?.event_key);
  const send = useCallback(async (action: string, data = {}, expected?: number) => {
    const state = current.current;
    if (!state) throw new Error("Meeting has not loaded");
    const result = await api<PicklistMeetingState>("/api/picklists/meeting", { method: "POST", body: { event_key: state.event_key, version: expected ?? state.version, action, data } });
    current.current = result; setMeeting(result);
  }, []);
  const edits = useRecoveredEdit<{ version: number; boards: Record<string, PicklistItem[]> }>(`hazehub.picklist.meeting:${session?.scout_id}:${meeting?.event_key || "loading"}`, async pending => {
    await send("edit_boards", { boards: pending.boards }, pending.version);
    const version = current.current!.version;
    return latest => ({ ...latest, version });
  });
  const act = async (action: string, data = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      if (edits.pending && !await edits.flush()) throw new Error("Save or discard pending ranking changes first");
      await send(action, data);
    } catch (e: any) { toast(e.message, "err"); await load(); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const team = meeting?.selected_team;
    setNote(team ? meeting?.notes[team] || "" : "");
    setStatus(team ? meeting?.team_statuses[team] || "Available" : "Available");
  }, [meeting?.selected_team, meeting?.notes, meeting?.team_statuses]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!isAdmin || meeting?.status !== "live" || (e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true],[role=dialog]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); void act(e.shiftKey ? "redo" : "undo"); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  });
  async function showHistory(offset = 0) {
    try { const result = await api<{ entries: any[]; total: number }>(`/api/picklists/history?event=${encodeURIComponent(meeting!.event_key)}&offset=${offset}`); setHistory(rows => offset ? [...rows || [], ...result.entries] : result.entries); setHistoryTotal(result.total); }
    catch (e: any) { toast(e.message, "err"); }
  }
  if (!meeting) return error ? <p role="alert">{error}</p> : <Loading />;
  const canEdit = isAdmin && meeting.status === "live" && !busy;
  const selected = meeting.selected_team;
  return <div>
    <div className="page-title"><h1>Picklist Meeting Mode</h1><Link className="btn" href="/picklists">My picklists</Link></div>
    <div className="btn-row" style={{ flexWrap: "wrap" }}><span className="badge haze">{meeting.event_key}</span><span className="badge muted">{meeting.status.replace("_", " ")}</span><span className="badge muted">{meeting.viewers} connected</span><span role="status" className="faint">{edits.status} · {meeting.locked ? "Submissions locked" : "Submissions open"}</span></div>
    {error && <p role="alert">Reconnecting: {error}</p>}
    {edits.pending && <div className="card"><p>{edits.status}</p><div className="btn-row"><button className="btn" onClick={() => edits.flush()}>Retry save</button><button className="btn" onClick={async () => { if (await confirm("Discard local unsaved ranking changes and reload the shared meeting?")) { edits.discard(); void load(); } }}>Discard local changes</button></div></div>}
    {isAdmin && <section className="card" style={{ marginTop: 16 }}><h2>Meeting controls</h2><div className="btn-row" style={{ flexWrap: "wrap" }}>
      {(meeting.status === "not_started" || meeting.status === "ended") && <button className="btn primary" disabled={busy} onClick={() => act("start")}>Start meeting</button>}
      {meeting.status === "live" && <button className="btn" disabled={busy} onClick={() => act("pause")}>Pause meeting</button>}
      {meeting.status === "paused" && <button className="btn primary" disabled={busy} onClick={() => act("resume")}>Resume meeting</button>}
      {["live", "paused"].includes(meeting.status) && <button className="btn" disabled={busy} onClick={async () => { if (await confirm("End and archive this meeting? Submissions and official lists will be kept.")) void act("end"); }}>End meeting</button>}
      <button className="btn" disabled={busy} onClick={() => act("lock", { locked: !meeting.locked })}>{meeting.locked ? "Unlock" : "Lock"} submissions</button>
      <button className="btn" disabled={busy} onClick={() => showHistory()}>Activity & history</button>
      <button className="btn" disabled={busy} onClick={async () => { if (await confirm("Clear temporary selections and connection presence, then resync? Rankings, submissions, history, and logins stay saved.")) void act("clear_temporary"); }}>Clear temporary meeting state</button>
      <button className="btn danger" disabled={busy} onClick={async () => { if (await confirm("Reset the meeting to Not Started and clear working boards? Submitted lists and published history will be kept.")) void act("reset"); }}>Reset meeting</button>
      <button className="btn primary" disabled={busy || !!edits.pending || meeting.status === "not_started"} onClick={() => setPublish(true)}>Publish Final Picklists</button>
      {meeting.published && <button className="btn danger" disabled={busy} onClick={async () => { if (await confirm("Unpublish official picklists? Previous publications stay in history.")) void act("unpublish"); }}>Unpublish</button>}
    </div></section>}
    {meeting.status === "not_started" ? <section className="card" style={{ marginTop: 16 }}><h2>Picklist Meeting Has Not Started Yet</h2><p>Waiting for Admin to start the picklist meeting.</p></section> : <>
      <div className="btn-row" style={{ margin: "16px 0", flexWrap: "wrap" }}><div className="seg">{(["first", "second", "both"] as const).map(v => <button key={v} className={meeting.view === v ? "on" : ""} disabled={!isAdmin || busy || !!edits.pending} onClick={() => act("view", { view: v })}>{v === "both" ? "Side by side" : `${v === "first" ? "First" : "Second"} Pick`}</button>)}</div><label><input type="checkbox" checked={hide} onChange={e => setHide(e.target.checked)} /> Hide unavailable teams</label>{isAdmin && <><button className="btn" disabled={!canEdit || !meeting.can_undo} onClick={() => act("undo")}>Undo</button><button className="btn" disabled={!canEdit || !meeting.can_redo} onClick={() => act("redo")}>Redo</button></>}</div>
      {meeting.status === "paused" && <p className="badge muted">Meeting paused · rankings are read-only</p>}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 390px), 1fr))", gap: 16 }}>
        {meeting.boards.filter(b => meeting.view === "both" || b.pick_round === (meeting.view === "first" ? 1 : 2)).map(b => <section className="card" key={b.pick_round}><PicklistBoard list={{ ...b, items: edits.pending?.boards[b.pick_round] || b.items }} teams={teams} pool={pool} canEdit={canEdit} teamStatuses={meeting.team_statuses} hideUnavailable={hide} selectedTeam={selected} onSelectTeam={isAdmin ? team => { void act("select", { team }); setDetails(team); } : undefined} onChange={items => edits.enqueue({ version: edits.pending?.version ?? meeting.version, boards: { ...edits.pending?.boards, [b.pick_round]: items } })} /></section>)}
      </div>
      <section className="card" style={{ marginTop: 16 }}><h2>Team discussion{selected ? ` · ${selected}` : ""}</h2>
        {isAdmin && <form className="btn-row" onSubmit={e => { e.preventDefault(); if (Number(teamInput) > 0) void act("select", { team: Number(teamInput) }); }}><input aria-label="Team to discuss" placeholder="Team number" type="number" min="1" value={teamInput} onChange={e => setTeamInput(e.target.value)} /><button className="btn" disabled={busy}>Select team</button></form>}
        {selected ? <><button className="btn" onClick={() => setDetails(selected)}>View team {selected} scouting metrics</button><p>{teams[selected]?.nickname}</p><label>Availability<select disabled={!canEdit} value={status} onChange={e => setStatus(e.target.value)}>{["Available", "Already Selected", "Unavailable", "Do Not Pick"].map(s => <option key={s}>{s}</option>)}</select></label><label>Shared discussion notes<textarea readOnly={!canEdit} maxLength={5000} value={note} onChange={e => setNote(e.target.value)} /></label>{canEdit && <button className="btn" onClick={() => act("team", { team: selected, status, note })}>Save team notes & status</button>}</> : <p className="faint">Admin can select a team for everyone to discuss.</p>}
        <h3>Do Not Pick</h3><div className="btn-row">{Object.entries(meeting.team_statuses).filter(([, s]) => s === "Do Not Pick").map(([t]) => <button className="btn sm danger" key={t} onClick={() => isAdmin ? act("select", { team: Number(t) }) : setDetails(Number(t))}>{t} {teams[Number(t)]?.nickname}</button>)}</div>
      </section>
    </>}
    {isAdmin && <SubmittedPicklists event={meeting.event_key} teams={teams} onImport={canEdit ? list => { void act("import", { source_id: list.id, pick_round: list.pick_round }); } : undefined} />}
    <div style={{ marginTop: 16 }}><FinalPicklists teams={teams} /></div>
    {details && <TeamDetailModal teamNumber={details} onClose={() => setDetails(undefined)} />}
    {publish && <Modal dialog onClose={() => setPublish(false)}><h2>Publish Final Picklists</h2><p>These become the official lists for {meeting.event_key}. Previous publications remain in history.</p><div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>{meeting.boards.map(b => <div key={b.pick_round}><h3>{b.name}</h3><ol>{b.items.map(i => <li key={i.team}>{i.team} {teams[i.team]?.nickname}</li>)}</ol></div>)}</div><div className="btn-row"><button className="btn primary" disabled={busy} onClick={async () => { await act("publish"); setPublish(false); }}>Confirm publication</button><button className="btn" onClick={() => setPublish(false)}>Cancel</button></div></Modal>}
    {history && <Modal dialog onClose={() => setHistory(null)}><h2>Meeting activity & history</h2>{!history.length && <p>No meeting activity yet.</p>}{history.map(h => <details key={h.id}><summary>{h.action.replace("_", " ")} · {h.actor} · {new Date(h.created_at).toLocaleString()}</summary><div className="grid">{h.snapshot.boards.map((b: any) => <div key={b.pick_round}><h3>{b.name}</h3><ol>{b.items.map((i: PicklistItem) => <li key={i.team}>{i.team}</li>)}</ol></div>)}</div>{h.published && <p>Official publication: {new Date(h.published.published_at).toLocaleString()}</p>}<button className="btn" disabled={!canEdit} onClick={async () => { if (await confirm("Restore these working boards, notes, and statuses? Official results stay unchanged until you publish.")) { void act("restore", { id: h.id }); setHistory(null); } }}>Restore working boards</button></details>)}{history.length < historyTotal && <button className="btn" onClick={() => showHistory(history.length)}>Load older history</button>}<button className="btn" onClick={() => setHistory(null)}>Close</button></Modal>}
    {confirmation}
  </div>;
}
