"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePicklistConfirm } from "@/components/PicklistConfirm";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { usePicklistLive, usePicklistTeams, useRecoveredEdit } from "@/lib/picklists";
import type { MeetingRobot, PicklistItem, PicklistMeetingState } from "@/lib/types";
import { Loading, Modal, TeamIdentity } from "@/components/ui";
import { PicklistBoard } from "@/components/PicklistBoard";
import { SubmittedPicklists } from "@/components/SubmittedPicklists";
import { TeamDetailModal } from "@/components/TeamDetailModal";
import { FinalPicklists } from "@/components/FinalPicklists";
import { DataAnalysisPanel } from "@/components/DataAnalysisPanel";
import { MatchRefModal } from "@/components/MatchRef";
import type { RefTarget } from "@/lib/matchref";

const defaults: MeetingRobot[] = [{ team_number: 418, name: "Purple Haze" }, { team_number: 436, name: "Purple Rain" }];

export default function MeetingPage() {
  const { session } = useAuth();
  const isAdmin = session?.scout_id === "Admin" && session?.role === "admin";
  const toast = useToast();
  const { confirm, confirmation } = usePicklistConfirm();
  const [meeting, setMeeting] = useState<PicklistMeetingState>();
  const current = useRef(meeting); current.current = meeting;
  const client = useRef("");
  const comparisonQueue = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [publish, setPublish] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [teamQuery, setTeamQuery] = useState("");
  const [robotDialog, setRobotDialog] = useState(false);
  const [manageRobot, setManageRobot] = useState(false);
  const [robotNumber, setRobotNumber] = useState(0);
  const [robotName, setRobotName] = useState("");
  const load = useCallback(async () => {
    try {
      if (!client.current) client.current = crypto.randomUUID();
      const next = await api<PicklistMeetingState>(`/api/picklists/meeting?client=${client.current}`);
      setMeeting(old => !old || next.event_key !== old.event_key || next.version >= old.version ? next : old);
      setError("");
    } catch (e: any) { setError(e.message); }
  }, []);
  usePicklistLive(load, 1000);
  const { pool, teams } = usePicklistTeams(meeting?.event_key);
  const send = useCallback(async (action: string, data = {}, expected?: number) => {
    const state = current.current;
    if (!state) throw new Error("Meeting has not loaded");
    const result = await api<PicklistMeetingState>("/api/picklists/meeting", { method: "POST", body: { event_key: state.event_key, version: expected ?? state.version, action, data } });
    current.current = result; setMeeting(result);
  }, []);
  const shareComparison = useCallback((ids: number[]) => {
    comparisonQueue.current = comparisonQueue.current
      .catch(() => undefined)
      .then(() => send("present", { type: "comparison", comparison_ids: ids }))
      .catch(async (e: any) => { toast(e.message || "Could not share the comparison", "err"); await load(); });
    return comparisonQueue.current;
  }, [load, send, toast]);
  const edits = useRecoveredEdit<{ version: number; robot_number: number; boards: Record<string, PicklistItem[]> }>(`hazehub.picklist.meeting:${session?.scout_id}:${meeting?.event_key || "loading"}`, async pending => {
    await send("edit_boards", { boards: pending.boards, robot_number: pending.robot_number }, pending.version);
    const version = current.current!.version;
    return latest => ({ ...latest, version });
  }, 180);
  const act = async (action: string, data = {}) => {
    if (busy || !isAdmin) return;
    setBusy(true);
    try {
      if (edits.pending && !await edits.flush()) throw new Error("Save or discard pending ranking changes first");
      await send(action, data);
    } catch (e: any) { toast(e.message, "err"); await load(); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!isAdmin || meeting?.status !== "live" || (e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true],[role=dialog]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); void act(e.shiftKey ? "redo" : "undo"); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    if (!isAdmin) return;
    const shareReference = (event: Event) => {
      const custom = event as CustomEvent<{ team: number; match: RefTarget; field: string }>;
      custom.preventDefault();
      void act("present", { type: "reference", ...custom.detail });
    };
    window.addEventListener("hazehub-match-ref-open", shareReference);
    return () => window.removeEventListener("hazehub-match-ref-open", shareReference);
  });
  async function showHistory(offset = 0) {
    try { const result = await api<{ entries: any[]; total: number }>(`/api/picklists/history?event=${encodeURIComponent(meeting!.event_key)}&offset=${offset}`); setHistory(rows => offset ? [...rows || [], ...result.entries] : result.entries); setHistoryTotal(result.total); }
    catch (e: any) { toast(e.message, "err"); }
  }
  const matches = useMemo(() => {
    const q = teamQuery.trim().toLowerCase();
    if (!q) return [];
    return pool.filter(number => String(number).includes(q) || (teams[number]?.nickname || "").toLowerCase().includes(q)).slice(0, 8).map(number => teams[number] || { team_number: number });
  }, [pool, teamQuery, teams]);
  if (!meeting) return error ? <p role="alert">{error}</p> : <Loading />;
  const robots = meeting.robots?.length ? meeting.robots : defaults;
  const activeRobot = meeting.active_robot || robots[0].team_number;
  const presentation = meeting.presentation || { type: "none" as const, team: null, comparison_ids: [] };
  const activeBoards = meeting.boards.filter(b => (b.robot_number || robots[0].team_number) === activeRobot && (meeting.view === "both" || b.pick_round === (meeting.view === "first" ? 1 : 2)));
  const canEdit = isAdmin && meeting.status === "live" && !busy;
  return <div>
    <div className="page-title"><h1>Picklist Meeting Mode</h1><div className="btn-row"><Link className="btn primary" href="/picklist-simulator">Simulate a picklist</Link><Link className="btn" href="/picklists">My picklists</Link></div></div>
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
      <button className="btn" disabled={busy} onClick={() => act("present", { type: "analysis" })}>Open Data Analysis</button>
      <button className="btn" disabled={busy} onClick={() => act("present", { type: "comparison", comparison_ids: presentation.comparison_ids })}>Compare Picklists</button>
      <button className="btn danger" disabled={busy} onClick={async () => { if (await confirm("Reset the meeting to Not Started and clear working boards? Submitted lists and published history will be kept.")) void act("reset"); }}>Reset meeting</button>
      <button className="btn primary" disabled={busy || !!edits.pending || meeting.status === "not_started"} onClick={() => setPublish(true)}>Publish Final Picklists</button>
      {meeting.published && <button className="btn danger" disabled={busy} onClick={async () => { if (await confirm("Unpublish official picklists? Previous publications stay in history.")) void act("unpublish"); }}>Unpublish</button>}
    </div></section>}
    {meeting.status === "not_started" ? <section className="card" style={{ marginTop: 16 }}><h2>Picklist Meeting Has Not Started Yet</h2><p>Waiting for Admin to start the picklist meeting.</p></section> : <>
      <nav className="robot-tabs" aria-label="Meeting robots">{robots.map(robot => <button key={robot.team_number} className={activeRobot === robot.team_number ? "on" : ""} disabled={!isAdmin || busy} onClick={() => act("select_robot", { robot_number: robot.team_number })}><b>{robot.team_number}</b><span>{robot.name}</span></button>)}{isAdmin && <button aria-label="Add robot" onClick={() => setRobotDialog(true)}>+</button>}</nav>
      <div className="btn-row" style={{ margin: "16px 0", flexWrap: "wrap" }}><div className="seg">{(["first", "second", "both"] as const).map(v => <button key={v} className={meeting.view === v ? "on" : ""} disabled={!isAdmin || busy || !!edits.pending} onClick={() => act("view", { view: v })}>{v === "both" ? "Side by side" : `${v === "first" ? "First" : "Second"} Pick`}</button>)}</div>{isAdmin && <><button className="btn" disabled={!canEdit || !meeting.can_undo} onClick={() => act("undo")}>Undo</button><button className="btn" disabled={!canEdit || !meeting.can_redo} onClick={() => act("redo")}>Redo</button>{robots.find(robot => robot.team_number === activeRobot)?.custom && <button className="btn" onClick={() => { setRobotName(robots.find(robot => robot.team_number === activeRobot)?.name || ""); setManageRobot(true); }}>Manage robot</button>}</>}</div>
      {meeting.status === "paused" && <p className="badge muted">Meeting paused · rankings are read-only</p>}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 390px), 1fr))", gap: 16 }}>{activeBoards.map(b => <section className="card" key={`${activeRobot}-${b.pick_round}`}><PicklistBoard list={{ ...b, items: edits.pending?.robot_number === activeRobot ? edits.pending?.boards[b.pick_round] || b.items : b.items }} teams={teams} pool={pool} canEdit={canEdit} selectedTeam={presentation.team || undefined} onSelectTeam={isAdmin ? team => void act("present", { type: "team", team }) : undefined} onChange={items => edits.enqueue({ version: edits.pending?.version ?? meeting.version, robot_number: activeRobot, boards: { ...edits.pending?.boards, [b.pick_round]: items } })} /></section>)}</div>
      <section className="card team-explorer" style={{ marginTop: 16 }}><div className="card-h"><div><h2>Team Explorer</h2><p className="faint">Search teams at this competition and open their complete scouting record for everyone in the meeting.</p></div>{isAdmin && <button className="btn" onClick={() => act("present", { type: "analysis" })}>Open Data Analysis</button>}</div>{isAdmin ? <><input aria-label="Search teams" placeholder="Team number or name" value={teamQuery} onChange={e => setTeamQuery(e.target.value)} />{!!matches.length && <div className="team-explorer-results">{matches.map(team => <button key={team.team_number} onClick={() => { setTeamQuery(""); void act("present", { type: "team", team: team.team_number }); }}><TeamIdentity team={team} /></button>)}</div>}</> : <p className="faint">The admin controls the shared team and analysis view.</p>}</section>
    </>}
    {(isAdmin || presentation.type === "comparison") && <SubmittedPicklists event={meeting.event_key} teams={teams} robotNumber={activeRobot} sharedSelection={presentation.comparison_ids} onSharedSelection={isAdmin ? shareComparison : undefined} onImport={canEdit ? list => { void act("import", { source_id: list.id, pick_round: list.pick_round, robot_number: activeRobot }); } : undefined} />}
    <div style={{ marginTop: 16 }}><FinalPicklists teams={teams} /></div>
    {presentation.type === "team" && presentation.team && <TeamDetailModal teamNumber={presentation.team} onClose={() => { if (isAdmin) void act("present", { type: "none" }); }} />}
    {presentation.type === "analysis" && <Modal onClose={() => { if (isAdmin) void act("present", { type: "none" }); }}><div className="modal-head"><h2>Data Analysis</h2>{isAdmin && <button className="btn" onClick={() => act("present", { type: "none" })}>Close for everyone</button>}</div><DataAnalysisPanel /></Modal>}
    {presentation.type === "reference" && presentation.team && presentation.match != null && <MatchRefModal team={presentation.team} match={presentation.match as RefTarget} field={presentation.field || "all"} onClose={() => { if (isAdmin) void act("present", { type: "none" }); }} />}
    {robotDialog && <Modal dialog onClose={() => setRobotDialog(false)}><h2>Add Robot</h2><label>Team number<input type="number" min={1} max={99999} value={robotNumber || ""} onChange={e => setRobotNumber(Number(e.target.value))} /></label><label>Display name<input value={robotName} maxLength={100} onChange={e => setRobotName(e.target.value)} /></label><div className="btn-row"><button className="btn primary" disabled={robotNumber < 1 || !robotName.trim()} onClick={async () => { await act("add_robot", { robot_number: robotNumber, name: robotName }); setRobotDialog(false); setRobotNumber(0); setRobotName(""); }}>Add robot</button><button className="btn" onClick={() => setRobotDialog(false)}>Cancel</button></div></Modal>}
    {manageRobot && <Modal dialog onClose={() => setManageRobot(false)}><h2>Manage Robot {activeRobot}</h2><label>Display name<input autoFocus value={robotName} maxLength={100} onChange={e => setRobotName(e.target.value)} /></label><div className="btn-row"><button className="btn primary" disabled={!robotName.trim()} onClick={async () => { await act("rename_robot", { robot_number: activeRobot, name: robotName }); setManageRobot(false); }}>Save name</button><button className="btn danger" onClick={async () => { if (await confirm(`Remove Robot ${activeRobot} and its working First and Second Pick lists? Submitted lists will remain.`)) { await act("remove_robot", { robot_number: activeRobot }); setManageRobot(false); } }}>Remove robot</button><button className="btn" onClick={() => setManageRobot(false)}>Cancel</button></div></Modal>}
    {publish && <Modal dialog onClose={() => setPublish(false)}><h2>Publish Final Picklists</h2><p>Every non-empty robot list below becomes official for {meeting.event_key}.</p><div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>{meeting.boards.filter(b => b.items.length).map(b => <div key={`${b.robot_number}-${b.pick_round}`}><h3>{b.robot_number || 418} · {b.pick_round === 1 ? "First" : "Second"} Pick</h3><ol>{b.items.map(i => <li key={i.team}>{i.team} {teams[i.team]?.nickname}</li>)}</ol></div>)}</div><div className="btn-row"><button className="btn primary" disabled={busy || !meeting.boards.some(b => b.items.length)} onClick={async () => { await act("publish"); setPublish(false); }}>Confirm publication</button><button className="btn" onClick={() => setPublish(false)}>Cancel</button></div></Modal>}
    {history && <Modal dialog onClose={() => setHistory(null)}><h2>Meeting activity & history</h2>{!history.length && <p>No meeting activity yet.</p>}{history.map(h => <details key={h.id}><summary>{h.action.replaceAll("_", " ")} · {h.actor} · {new Date(h.created_at).toLocaleString()}</summary><div className="grid">{h.snapshot.boards.map((b: any) => <div key={`${b.robot_number}-${b.pick_round}`}><h3>{b.robot_number || 418} · {b.name}</h3><ol>{b.items.map((i: PicklistItem) => <li key={i.team}>{i.team}</li>)}</ol></div>)}</div><button className="btn" disabled={!canEdit} onClick={async () => { if (await confirm("Restore these working boards? Official results stay unchanged until you publish.")) { void act("restore", { id: h.id }); setHistory(null); } }}>Restore working boards</button></details>)}{history.length < historyTotal && <button className="btn" onClick={() => showHistory(history.length)}>Load older history</button>}<button className="btn" onClick={() => setHistory(null)}>Close</button></Modal>}
    {confirmation}
  </div>;
}
