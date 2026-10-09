"use client";
import { useCallback, useEffect, useState } from "react";
import { usePicklistConfirm } from "@/components/PicklistConfirm";
import { api } from "@/lib/api";
import { usePicklistLive } from "@/lib/picklists";
import type { PicklistRecord, Team } from "@/lib/types";
import { Modal } from "./ui";
import { PicklistBoard } from "./PicklistBoard";

export function SubmittedPicklists({ event, teams, onImport }: { event: string; teams: Record<number, Team>; onImport?: (list: PicklistRecord) => void }) {
  const { confirm, confirmation } = usePicklistConfirm();
  const [lists, setLists] = useState<PicklistRecord[]>([]);
  const [query, setQuery] = useState("");
  const [round, setRound] = useState(1);
  const [versions, setVersions] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [open, setOpen] = useState<PicklistRecord>();
  const [sort, setSort] = useState("average");
  const [comparison, setComparison] = useState<{ teams: any[]; list_count: number }>({ teams: [], list_count: 0 });
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setLists(await api<PicklistRecord[]>(`/api/picklists/submissions?event=${encodeURIComponent(event)}`)); setError(""); }
    catch (e: any) { setError(e.message); }
  }, [event]);
  usePicklistLive(load);
  const filtered = lists.filter(l => l.pick_round === round && (versions || l.latest) && `${l.name} ${l.owner_name}`.toLowerCase().includes(query.toLowerCase()));
  const compared = lists.filter(l => selected.includes(l.id) && l.pick_round === round);
  useEffect(() => {
    let cancelled = false;
    if (!selected.length) { setComparison({ teams: [], list_count: 0 }); return; }
    setComparing(true);
    const timer = setTimeout(() => {
      api<{ teams: any[]; list_count: number }>("/api/picklists/compare", { method: "POST", body: { event_key: event, ids: selected, pick_round: round, sort } })
        .then(result => { if (!cancelled) { setComparison(result); setError(""); } })
        .catch((e: any) => { if (!cancelled) setError(e.message); })
        .finally(() => { if (!cancelled) setComparing(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [event, selected, round, sort, lists]);
  const ordered = comparison.teams;
  return <section className="card" style={{ marginTop: 16 }}><h2>Submitted Picklists</h2>
    <p className="faint">Search by list name or scouter. References are read-only; importing copies a list into the meeting.</p>
    {error && <p role="alert">{error}</p>}
    <div className="btn-row" style={{ flexWrap: "wrap" }}><input aria-label="Search submitted picklists" placeholder="List name or scouter name" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Submission round" value={round} onChange={e => { setRound(Number(e.target.value)); setSelected([]); }}><option value={1}>First Pick</option><option value={2}>Second Pick</option></select><label><input type="checkbox" checked={versions} onChange={e => setVersions(e.target.checked)} /> Show earlier versions</label></div>
    {!filtered.length && <p className="faint">No matching submitted lists.</p>}
    <div style={{ overflowX: "auto" }}><table className="data"><thead><tr><th>Compare</th><th>Name</th><th>Scouter</th><th>Version</th><th>Submitted</th><th>Reference</th></tr></thead><tbody>{filtered.map(l => <tr key={l.id}><td><input aria-label={`Compare ${l.name} version ${l.version}`} type="checkbox" checked={selected.includes(l.id)} onChange={e => setSelected(s => e.target.checked ? [...s, l.id] : s.filter(i => i !== l.id))} /></td><td>{l.name}</td><td>{l.owner_name}</td><td>v{l.version} {l.latest && <span className="badge haze">Latest</span>}</td><td>{new Date(l.updated_at).toLocaleString()}</td><td><button className="btn sm" onClick={() => setOpen(l)}>Open reference</button>{onImport && <button className="btn sm" onClick={async () => { if (await confirm(`Copy ${l.name} into the ${round === 1 ? "First" : "Second"} Pick meeting board? This replaces its current working ranking; the submission stays unchanged.`)) onImport(l); }}>Import copy</button>}</td></tr>)}</tbody></table></div>
    {!!compared.length && <><h3>Compare {round === 1 ? "First" : "Second"} Pick · {compared.length} lists</h3><label>Sort by <select value={sort} onChange={e => setSort(e.target.value)}><option value="average">Average rank</option><option value="frequency">Most frequently selected</option><option value="team">Team number</option><option value="metric:avg_points">Average points</option><option value="metric:operational_rate">Operational rate</option></select></label><p className="faint">Average rank uses only lists containing that team. Spread is worst minus best rank. These comparisons do not change the meeting order.</p><div style={{ overflowX: "auto" }}><table className="data"><thead><tr><th>Team</th><th>Frequency</th><th>Average</th><th>Best</th><th>Worst</th><th>Spread</th><th>Ranks by list</th>{sort.startsWith("metric:") && <th>Metric</th>}</tr></thead><tbody>{ordered.map(r => <tr key={r.team}><td>{r.team} {teams[r.team]?.nickname}</td><td>{r.frequency}/{compared.length}</td><td>{r.average.toFixed(1)}</td><td>{r.best}</td><td>{r.worst}</td><td>{r.spread}</td><td>{r.values.map(v => `${v.list}: ${v.rank}`).join(" · ")}</td>{sort.startsWith("metric:") && <td>{metrics[r.team]?.[sort.slice(7)] ?? "—"}</td>}</tr>)}</tbody></table></div></>}
    {open && <Modal dialog onClose={() => setOpen(undefined)}><h2>{open.name}</h2><p>{open.owner_name} · v{open.version} · Read-only reference</p><PicklistBoard list={open} teams={teams} pool={[]} canEdit={false} onChange={() => {}} /><button className="btn" onClick={() => setOpen(undefined)}>Close</button></Modal>}
    {confirmation}
  </section>;
}
