"use client";
import { useCallback, useRef, useState } from "react";
import { api } from "@/lib/api";
import { usePicklistLive } from "@/lib/picklists";
import type { Picklist, Team } from "@/lib/types";
import { ClickableTeam } from "./TeamDetailModal";
import { Modal } from "./ui";
import { PicklistBoard } from "./PicklistBoard";

export function FinalPicklists({ teams = {} }: { teams?: Record<number, Team> }) {
  const [lists, setLists] = useState<(Picklist & { published_at: string })[]>([]);
  const known = useRef(new Set<number>());
  const [extra, setExtra] = useState<Record<number, Team>>({});
  const [open, setOpen] = useState<Picklist>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const rows = await api<(Picklist & { published_at: string })[]>("/api/picklists/finals");
      setLists(rows); setOpen(old => old ? rows.find(r => r.pick_round === old.pick_round && r.event_key === old.event_key && (r.robot_number || 418) === (old.robot_number || 418)) : undefined); setError("");
      const nums = [...new Set(rows.flatMap(l => l.items.map(i => i.team)))].filter(n => !known.current.has(n));
      const all: Team[] = [];
      for (let i = 0; i < nums.length; i += 24) all.push(...await api<Team[]>("/api/teams/batch", { method: "POST", body: { teams: nums.slice(i, i + 24) } }));
      all.forEach(t => known.current.add(t.team_number));
      if (all.length) setExtra(old => ({ ...old, ...Object.fromEntries(all.map(t => [t.team_number, t])) }));
    } catch (e: any) { setError(e.message); }
  }, []);
  usePicklistLive(load, 30000);
  return <section className="final-picks card" style={{ marginBottom: 16 }}><div className="card-h"><h2>Official Picklists</h2><span className="badge haze">Published by Admin</span></div>
    {error && <p role="alert">{error}</p>}
    {!lists.length && <p className="faint">No official picklists have been published for this competition yet.</p>}
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>{[...lists].sort((a, b) => ((a.robot_number || 418) === 418 ? -1 : (a.robot_number || 418) === 436 ? 0 : a.robot_number || 418) - ((b.robot_number || 418) === 418 ? -1 : (b.robot_number || 418) === 436 ? 0 : b.robot_number || 418) || a.pick_round - b.pick_round).map(l => <div className="final-pick-card" key={`${l.robot_number || 418}-${l.pick_round}`}><h3>Final {l.pick_round === 1 ? "First" : "Second"} Pick</h3><p><b>{l.robot_number || 418} · {l.robot_name || ((l.robot_number || 418) === 418 ? "Purple Haze" : "Purple Rain")}</b></p><p className="faint">{l.event_key} · {new Date(l.published_at).toLocaleString()}</p><ol className="list-card-items">{l.items.slice(0, 10).map((i, index) => <li key={i.team}><span className="rank-chip sm">{index + 1}</span><ClickableTeam team={teams[i.team] || extra[i.team] || { team_number: i.team, nickname: "" }} /></li>)}</ol><button className="btn sm" onClick={() => setOpen(l)}>Open full list ({l.items.length})</button></div>)}</div>
    {open && <Modal dialog onClose={() => setOpen(undefined)}><h2>{open.name}</h2><PicklistBoard list={open} teams={{ ...extra, ...teams }} pool={[]} canEdit={false} onChange={() => {}} /><button className="btn" onClick={() => setOpen(undefined)}>Close</button></Modal>}
  </section>;
}
