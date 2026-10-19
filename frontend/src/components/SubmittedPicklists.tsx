"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePicklistConfirm } from "@/components/PicklistConfirm";
import { api } from "@/lib/api";
import { usePicklistLive } from "@/lib/picklists";
import type { PicklistItem, PicklistRecord, Team } from "@/lib/types";
import { Modal, TeamIdentity } from "./ui";

interface ComparisonValue { id: number; list: string; rank: number }
interface ComparisonRow {
  team: number;
  values: ComparisonValue[];
  frequency: number;
  average: number;
  best: number;
  worst: number;
  spread: number;
  metric?: number | null;
}

const reason = (item: PicklistItem) => item.justification || item.note || item.comments || "";

export function SubmittedPicklists({ event, teams, onImport, robotNumber, sharedSelection, onSharedSelection }: { event: string; teams: Record<number, Team>; onImport?: (list: PicklistRecord) => void; robotNumber?: number; sharedSelection?: number[]; onSharedSelection?: (ids: number[]) => void }) {
  const { confirm, confirmation } = usePicklistConfirm();
  const [lists, setLists] = useState<PicklistRecord[]>([]);
  const [query, setQuery] = useState("");
  const [round, setRound] = useState(1);
  const [localSelected, setLocalSelected] = useState<number[]>([]);
  const [pendingSelection, setPendingSelection] = useState<number[] | null>(null);
  const [sortByTeam, setSortByTeam] = useState(false);
  const [activeTeamOnly, setActiveTeamOnly] = useState(false);
  const selected = pendingSelection ?? sharedSelection ?? localSelected;
  const setSelected = (next: number[] | ((current: number[]) => number[])) => {
    const value = typeof next === "function" ? next(selected) : next;
    setLocalSelected(value);
    if (onSharedSelection) setPendingSelection(value);
  };
  const [open, setOpen] = useState<PicklistRecord>();
  const [sort, setSort] = useState("average");
  const [comparison, setComparison] = useState<{ teams: ComparisonRow[]; list_count: number }>({ teams: [], list_count: 0 });
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const rows = await api<PicklistRecord[]>(`/api/picklists/submissions?event=${encodeURIComponent(event)}`);
      setLists(rows);
      setLocalSelected(current => current.filter(id => rows.some(row => row.id === id)));
      setPendingSelection(current => current ? current.filter(id => rows.some(row => row.id === id)) : null);
      setError("");
    } catch (e: any) { setError(e.message); }
  }, [event]);
  usePicklistLive(load);

  const sharedHandler = useRef(onSharedSelection);
  useEffect(() => { sharedHandler.current = onSharedSelection; }, [onSharedSelection]);
  useEffect(() => {
    if (!sharedSelection) return;
    if (pendingSelection && JSON.stringify(pendingSelection) === JSON.stringify(sharedSelection)) setPendingSelection(null);
    if (!pendingSelection) setLocalSelected(sharedSelection);
  }, [sharedSelection, pendingSelection]);
  useEffect(() => {
    if (!pendingSelection || !sharedHandler.current) return;
    const timer = setTimeout(() => sharedHandler.current?.(pendingSelection), 120);
    return () => clearTimeout(timer);
  }, [pendingSelection]);

  const filtered = useMemo(() => lists.filter(list =>
    list.pick_round === round &&
    (!activeTeamOnly || !robotNumber || (list.robot_number || 418) === robotNumber) &&
    `${list.name} ${list.owner_name} ${list.robot_number || 418}`.toLowerCase().includes(query.trim().toLowerCase())
  ).sort((a, b) => sortByTeam ? (a.robot_number || 418) - (b.robot_number || 418) || a.name.localeCompare(b.name) : 0), [lists, query, round, robotNumber, activeTeamOnly, sortByTeam]);
  const compared = useMemo(() => selected.map(id => lists.find(list => list.id === id)).filter((list): list is PicklistRecord => !!list && list.pick_round === round), [lists, round, selected]);

  useEffect(() => {
    let cancelled = false;
    if (selected.length < 2) {
      setComparison({ teams: [], list_count: 0 });
      setComparing(false);
      return;
    }
    setComparing(true);
    const timer = setTimeout(() => {
      api<{ teams: ComparisonRow[]; list_count: number }>("/api/picklists/compare", {
        method: "POST",
        body: { event_key: event, ids: selected, pick_round: round, sort },
      })
        .then(result => { if (!cancelled) { setComparison(result); setError(""); } })
        .catch((e: any) => { if (!cancelled) setError(e.message); })
        .finally(() => { if (!cancelled) setComparing(false); });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [event, selected, round, sort]);

  function toggle(list: PicklistRecord) {
    setSelected(current => {
      if (current.includes(list.id)) return current.filter(id => id !== list.id);
      if (current.length >= 8) { setError("Compare up to eight picklists at a time."); return current; }
      setError("");
      return [...current, list.id];
    });
  }

  const agreement = comparison.teams.filter(row => row.frequency === compared.length).length;
  return <section className="card submitted-picklists" style={{ marginTop: 16 }}>
    <div className="card-h submitted-head"><div><h2>Submitted Picklists</h2><p className="faint">Every submission is an independent snapshot. Select two to eight lists to compare rankings side by side.</p></div><span className="badge haze">{filtered.length} list{filtered.length === 1 ? "" : "s"}</span></div>
    {error && <p role="alert" className="form-error">{error}</p>}

    <div className="picklist-browser-tools">
      <input aria-label="Search submitted picklists" placeholder="Search list, scouter, or team" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="seg" aria-label="Pick round">{[1, 2].map(value => <button type="button" key={value} className={round === value ? "on" : ""} aria-pressed={round === value} onClick={() => { setRound(value); setSelected([]); }}>{value === 1 ? "First Pick" : "Second Pick"}</button>)}</div>
      <button type="button" className={`btn${sortByTeam ? " primary" : ""}`} aria-pressed={sortByTeam} onClick={() => setSortByTeam(value => !value)}>Sort by team</button>
      {robotNumber && <button type="button" className={`btn${activeTeamOnly ? " primary" : ""}`} aria-pressed={activeTeamOnly} onClick={() => setActiveTeamOnly(value => !value)}>{activeTeamOnly ? `Team ${robotNumber} only` : "All destination teams"}</button>}
    </div>

    {!filtered.length ? <p className="faint">No submitted lists match these filters.</p> : <div className="submission-card-grid">{filtered.map(list => {
      const checked = selected.includes(list.id);
      return <article key={list.id} className={`submission-card${checked ? " selected" : ""}`}>
        <div className="submission-card-head">
          <label className="submission-select"><input aria-label={`Compare ${list.name} version ${list.version}`} type="checkbox" checked={checked} onChange={() => toggle(list)} /><span>{checked ? "Selected" : "Compare"}</span></label>
          <div><span className="badge haze">For Team {list.robot_number || 418}</span><span className="badge muted">#{list.submission_number || 1}</span></div>
        </div>
        <button type="button" className="submission-open" onClick={() => setOpen(list)}>
          <strong>{list.name}</strong>
          <span>{list.owner_name} · made for Team {list.robot_number || 418} · {new Date(list.submitted_at || list.updated_at).toLocaleString()}</span>
        </button>
        <ol className="submission-preview">{list.items.slice(0, 5).map((item, index) => <li key={item.team}><span className="rank-chip">{index + 1}</span><TeamIdentity team={teams[item.team] || { team_number: item.team, nickname: "" }} /></li>)}</ol>
        <p className="faint submission-count">{list.items.length} ranked team{list.items.length === 1 ? "" : "s"}{list.items.length > 5 ? ` · ${list.items.length - 5} more` : ""}</p>
        <div className="btn-row"><button className="btn sm" onClick={() => setOpen(list)}>View list</button>{onImport && <button className="btn sm primary" onClick={async () => { if (await confirm(`Copy ${list.name} into the ${round === 1 ? "First" : "Second"} Pick meeting board? This replaces its current working ranking; the submission stays unchanged.`)) onImport(list); }}>Import copy</button>}</div>
      </article>;
    })}</div>}

    <section className="picklist-compare-panel" aria-label="Picklist comparison">
      <div className="card-h"><div><h3>Compare Picklists</h3><p className="faint">{selected.length < 2 ? selected.length ? "Select one more list to compare." : "Select at least two lists above." : `${selected.length} lists selected · ${agreement} teams appear on every list`}</p></div>{selected.length > 0 && <button type="button" className="btn sm ghost" onClick={() => setSelected([])}>Clear</button>}</div>
      {!!compared.length && <div className="comparison-list-chips">{compared.map(list => <button type="button" className="chip on" key={list.id} onClick={() => toggle(list)} aria-label={`Remove ${list.name} from comparison`}>{list.name}<span>×</span></button>)}</div>}
      {selected.length >= 2 && <>
        <div className="comparison-toolbar"><label>Order teams<select value={sort} onChange={e => setSort(e.target.value)}><option value="average">Consensus rank</option><option value="frequency">Most selected</option><option value="team">Team number</option><option value="metric:avg_points">Haze Power Rating</option><option value="metric:operational_rate">Operational rate</option></select></label>{comparing && <span className="badge muted">Updating…</span>}</div>
        <div className="table-wrap comparison-table-wrap"><table className="data comparison-table"><thead><tr><th>Team</th><th>Consensus</th>{compared.map(list => <th key={list.id}><span>{list.name}</span><small>{list.owner_name}</small></th>)}<th>Spread</th>{sort.startsWith("metric:") && <th>Metric</th>}</tr></thead><tbody>{comparison.teams.map(row => {
          const ranks = new Map(row.values.map(value => [value.id, value.rank]));
          return <tr key={row.team}><td className="sticky-team-first"><TeamIdentity team={teams[row.team] || { team_number: row.team, nickname: "" }} /></td><td><b>#{row.average.toFixed(1)}</b><small>{row.frequency}/{comparison.list_count || compared.length} lists</small></td>{compared.map(list => <td key={list.id}>{ranks.has(list.id) ? <span className="comparison-rank">#{ranks.get(list.id)}</span> : <span className="faint">Not listed</span>}</td>)}<td>{row.spread}</td>{sort.startsWith("metric:") && <td>{row.metric ?? "—"}</td>}</tr>;
        })}</tbody></table></div>
        <p className="faint">Consensus is the average rank among lists containing that team. Spread is the difference between its best and worst selected-list rank.</p>
      </>}
    </section>

    {open && <Modal dialog onClose={() => setOpen(undefined)}><PicklistReference list={open} teams={teams} onClose={() => setOpen(undefined)} onImport={onImport ? async () => { if (await confirm(`Copy ${open.name} into the ${open.pick_round === 1 ? "First" : "Second"} Pick meeting board? This replaces its current working ranking; the submission stays unchanged.`)) { onImport(open); setOpen(undefined); } } : undefined} /></Modal>}
    {confirmation}
  </section>;
}

function PicklistReference({ list, teams, onClose, onImport }: { list: PicklistRecord; teams: Record<number, Team>; onClose: () => void; onImport?: () => void }) {
  return <div className="picklist-reference">
    <div className="modal-head"><div><span className="badge haze">For Team {list.robot_number || 418} · {list.pick_round === 1 ? "First Pick" : "Second Pick"}</span><h2>{list.name}</h2><p>{list.owner_name} · submission #{list.submission_number || 1} · {new Date(list.submitted_at || list.updated_at).toLocaleString()}</p></div><button className="btn" onClick={onClose}>Close</button></div>
    <div className="picklist-reference-summary"><b>{list.items.length}</b><span>ranked teams</span><i>Read-only submission</i></div>
    <ol className="picklist-reference-list">{list.items.map((item, index) => <li key={item.team}><span className="rank-chip">{index + 1}</span><div><TeamIdentity team={teams[item.team] || { team_number: item.team, nickname: "" }} />{reason(item) && <p>{reason(item)}</p>}</div></li>)}</ol>
    <div className="btn-row" style={{ justifyContent: "flex-end" }}>{onImport && <button className="btn primary" onClick={onImport}>Import a copy into meeting</button>}<button className="btn" onClick={onClose}>Done</button></div>
  </div>;
}
