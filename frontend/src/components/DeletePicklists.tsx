"use client";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { Modal, Confirm } from "./ui";
import type { PicklistRecord } from "@/lib/types";

export function DeletePicklists() {
  const { session } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PicklistRecord[]>([]);
  const [query, setQuery] = useState("");
  const [event, setEvent] = useState("");
  const [status, setStatus] = useState("");
  const [round, setRound] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [reset, setReset] = useState(false);
  const [all, setAll] = useState(false);
  const [extra, setExtra] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setRows(await api<PicklistRecord[]>("/api/picklists/all?all_events=true")); setSelected([]); }
    catch (e: any) { toast(e.message, "err"); }
  }, [toast]);
  if (session?.scout_id !== "Admin" || session.role !== "admin") return null;
  const filtered = rows.filter(r => (!event || r.event_key === event) && (!status || r.status === status) && (!round || r.pick_round === Number(round)) && `${r.name} ${r.owner_name} ${r.event_key}`.toLowerCase().includes(query.toLowerCase()));
  async function remove(resetAll = false) {
    setBusy(true);
    try {
      const result = await api<{ cleanup_pending?: boolean }>(`/api/picklists/${resetAll ? "reset" : "delete"}`, { method: "POST", body: resetAll ? { event_key: event || undefined, all_events: all, confirm_all: extra, confirmation: typed } : { ids: selected, all_events: true } });
      toast(result.cleanup_pending ? "Picklists reset. Storage cleanup is pending; repeat reset later to retry cleanup." : resetAll ? "Picklists reset" : "Selected picklists deleted", "ok"); setConfirm(false); setReset(false); setTyped(""); await load();
    } catch (e: any) { toast(e.message, "err"); }
    finally { setBusy(false); }
  }
  return <><button className="btn danger" onClick={() => { setOpen(true); void load(); }}>Delete Picklists</button>
    {open && <Modal dialog onClose={() => { if (!busy) setOpen(false); }}><h2>Delete Picklists</h2><p className="faint">Only picklist data is affected. End or reset an active meeting before deleting its lists. Deleting an official list removes it from the homepage; previous publication history is retained.</p><div className="btn-row" style={{ flexWrap: "wrap" }}><input aria-label="Search saved picklists" placeholder="Name, scouter, or competition" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Filter event" value={event} onChange={e => setEvent(e.target.value)}><option value="">All competitions</option>{[...new Set(rows.map(r => r.event_key))].map(e => <option key={e}>{e}</option>)}</select><select aria-label="Filter status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{["Draft", "Submitted", "Final", "Archived"].map(s => <option key={s}>{s}</option>)}</select><select aria-label="Filter round" value={round} onChange={e => setRound(e.target.value)}><option value="">Both rounds</option><option value="1">First Pick</option><option value="2">Second Pick</option></select></div>
    <div className="btn-row"><button className="btn sm" onClick={() => setSelected(filtered.map(r => String(r.id)))}>Select All filtered</button><button className="btn sm" onClick={() => setSelected([])}>Deselect All</button></div>
    <div style={{ maxHeight: "45vh", overflow: "auto" }}><table className="data"><thead><tr><th>Select</th><th>Name</th><th>Creator</th><th>Competition</th><th>Round</th><th>Updated</th><th>Status</th></tr></thead><tbody>{filtered.map(r => <tr key={r.id}><td><input aria-label={`Delete ${r.name}`} type="checkbox" disabled={busy} checked={selected.includes(String(r.id))} onChange={e => setSelected(s => e.target.checked ? [...s, String(r.id)] : s.filter(i => i !== String(r.id)))} /></td><td>{r.name}</td><td>{r.owner_name}</td><td>{r.event_key}</td><td>{r.pick_round === 1 ? "First Pick" : "Second Pick"}</td><td>{new Date(r.updated_at).toLocaleString()}</td><td>{r.status}</td></tr>)}</tbody></table></div><div className="btn-row"><button className="btn danger" disabled={busy || !selected.length} onClick={() => setConfirm(true)}>Delete Selected ({selected.length})</button><button className="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div><hr /><button className="btn danger" disabled={busy} onClick={() => { setReset(true); setAll(false); setExtra(false); setTyped(""); }}>Reset All Picklists</button></Modal>}
    {confirm && <Confirm title={`Delete ${selected.length} picklists?`} body="The selected lists will be permanently removed. Scouting observations, matches, teams, and accounts are unaffected." confirmLabel={busy ? "Deleting…" : "Delete selected"} onConfirm={() => { if (!busy) void remove(); }} onCancel={() => { if (!busy) setConfirm(false); }} />}
    {reset && <Modal dialog onClose={() => { if (!busy) setReset(false); }}><h2>Reset All Picklists</h2><p>This removes drafts, submissions, meeting boards, official results, and picklist history for the chosen scope. Scouting data, matches, teams, and accounts are not changed.</p><select aria-label="Reset scope" value={all ? "all" : "event"} onChange={e => { setAll(e.target.value === "all"); setExtra(false); }}><option value="event">{event || "Currently selected competition"}</option><option value="all">Every competition</option></select>{all && <label><input type="checkbox" checked={extra} onChange={e => setExtra(e.target.checked)} /> I also confirm deleting picklists across ALL competitions.</label>}<label>Type RESET PICKLISTS<input value={typed} onChange={e => setTyped(e.target.value)} /></label><div className="btn-row"><button className="btn danger" disabled={busy || typed !== "RESET PICKLISTS" || (all && !extra)} onClick={() => remove(true)}>Confirm reset</button><button className="btn" disabled={busy} onClick={() => setReset(false)}>Cancel</button></div></Modal>}
  </>;
}
