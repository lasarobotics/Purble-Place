"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { num } from "@/lib/format";
import type { AnalysisRow } from "@/components/DataAnalysisPanel";
import { Empty, Loading } from "@/components/ui";

type Slot = "captain" | "first" | "second";
const empty = { captain: 0, first: 0, second: 0 };

export default function PicklistSimulatorPage() {
  const [rows, setRows] = useState<AnalysisRow[] | null>(null);
  const [picks, setPicks] = useState<Record<Slot, number>>(empty);
  const load = useCallback(async () => {
    try {
      const analysis = await api<{ teams: AnalysisRow[] }>("/api/admin/data-analysis");
      setRows(analysis.teams);
      void api<{ teams: Partial<AnalysisRow>[] }>("/api/matches/event-ratings").then(external => {
        setRows(current => {
          const merged = new Map((current || analysis.teams).map(row => [row.team, row]));
          for (const rating of external.teams) {
            const team = Number(rating.team); const existing = merged.get(team);
            if (existing) merged.set(team, { ...existing, ...rating });
            else merged.set(team, { team, matches: 0, defense_capability: null, consistency: 0,
              skew_distribution: null, failure_rate: 0, foul_match_rate: 0,
              climb_success_rate: 0, ranking_point_prediction: null, ...rating });
          }
          return [...merged.values()];
        });
      }).catch(() => {});
    } catch { setRows([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem("hazehub.picklist.simulator") || "null"); if (saved) setPicks(saved); } catch {} }, []);
  useEffect(() => { localStorage.setItem("hazehub.picklist.simulator", JSON.stringify(picks)); }, [picks]);
  const selected = useMemo(() => Object.values(picks).map(team => rows?.find(row => row.team === team)).filter(Boolean) as AnalysisRow[], [picks, rows]);
  const total = (key: keyof AnalysisRow) => selected.reduce((sum, row) => sum + (typeof row[key] === "number" ? Number(row[key]) : 0), 0);
  if (!rows) return <Loading label="Loading simulator…" />;
  if (!rows.length) return <Empty title="No event teams available to simulate" />;
  const options = [...rows].sort((a, b) => a.team - b.team);
  return <div>
    <div className="page-title"><h1>Picklist Simulator</h1><Link className="btn" href="/meeting">Back to meeting</Link></div>
    <p className="faint">Build a private practice alliance without changing the live meeting. This simulation is saved only on this device.</p>
    <section className="simulator-layout">
      <div className="simulator-slots">
        {(["captain", "first", "second"] as Slot[]).map((slot, index) => <label className="simulator-slot" key={slot}><span>{index === 0 ? "Captain" : index === 1 ? "First pick" : "Second pick"}</span><select value={picks[slot]} onChange={e => setPicks(current => ({ ...current, [slot]: Number(e.target.value) }))}><option value={0}>Choose a team</option>{options.map(row => <option disabled={Object.entries(picks).some(([key, team]) => key !== slot && team === row.team)} value={row.team} key={row.team}>{row.team}{row.nickname ? ` · ${row.nickname}` : ""}</option>)}</select></label>)}
        <button className="btn" onClick={() => setPicks(empty)}>Clear simulation</button>
      </div>
      <div className="simulator-scorecard">
        <div><span>Alliance</span><strong>{selected.length}/3 teams</strong></div>
        <div><span>Haze Power Rating</span><strong>{num(total("avg_points"), 1)}</strong></div>
        <div><span>OPR</span><strong>{num(total("opr"), 1)}</strong></div>
        <div><span>EPA</span><strong>{num(total("match13_epa"), 1)}</strong></div>
        <div><span>xP</span><strong>{num(total("xp"), 1)}</strong></div>
      </div>
    </section>
    {!!selected.length && <div className="table-wrap"><table className="data"><thead><tr><th>Team</th><th className="num">Haze Power Rating</th><th className="num">OPR</th><th className="num">EPA</th><th className="num">xP</th></tr></thead><tbody>{selected.map(row => <tr key={row.team}><td><b>{row.team}</b> {row.nickname}</td><td className="num">{num(row.avg_points, 1)}</td><td className="num">{num(row.opr, 1)}</td><td className="num">{num(row.match13_epa, 1)}</td><td className="num">{num(row.xp, 1)}</td></tr>)}</tbody></table></div>}
  </div>;
}
